import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { readFileSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, hasPageAccess } from "../lib/workspace";
import { logger } from "../lib/logger";
import {
  driverAuthed,
  issueDriverToken,
  requireDriverToken,
  revokeDriverTokens,
} from "../lib/driverTokenAuth";
import { syncDriverToClerk } from "../lib/clerkDriverSync";
import { sendExpoPushNotification } from "../lib/expoPush";
import { subscribe as driverSseSubscribe, broadcast as driverSseBroadcast, broadcastStatusChange as driverSseBroadcastStatusChange } from "../lib/driverSse";
import { consumeOtpRateLimit, otpRateLimitClientIp } from "../lib/otpRateLimit";

/**
 * Returns a Router that handles only GET /fleet/me/sse.
 *
 * Accepts an optional `heartbeatMs` parameter so tests can inject a tiny
 * interval and use real timers instead of fake-timer toggling.
 */
export function createFleetSseRouter(heartbeatMs = 25_000): Router {
  const r = Router();

  r.get(
    "/fleet/me/sse",
    async (req: Request, res: Response): Promise<void> => {
      const raw = typeof req.query.token === "string" ? req.query.token.trim() : "";
      if (!raw) {
        fleetError(res, 401, "MISSING_TOKEN", "Missing token query parameter");
        return;
      }
      const { hashDriverToken, DRIVER_TOKEN_PREFIX } = await import("../lib/driverTokenAuth");
      let driverId: number;
      if (raw.startsWith(DRIVER_TOKEN_PREFIX)) {
        const tokenHash = hashDriverToken(raw);
        const result = await db.query<{
          driver_id: number;
          onboarding_status: string;
          deleted_at: string | null;
        }>(
          `SELECT t.driver_id, d.onboarding_status, d.deleted_at
             FROM fleet_driver_api_tokens t
             JOIN fleet_drivers d ON d.id = t.driver_id
            WHERE t.token_hash = $1 AND t.revoked_at IS NULL
            LIMIT 1`,
          [tokenHash],
        );
        const row = result.rows[0];
        if (!row || row.deleted_at || row.onboarding_status !== "approved") {
          fleetError(res, 401, "INVALID_TOKEN", "Token is invalid or revoked");
          return;
        }
        driverId = row.driver_id;
      } else {
        fleetError(res, 401, "INVALID_TOKEN", "Invalid token format");
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      res.write(": connected\n\n");
      res.write("retry: 15000\n\n");

      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);

      res.on("close", () => {
        clearInterval(heartbeat);
      });

      driverSseSubscribe(driverId, res);
    },
  );

  return r;
}

async function insertDriverNotification(
  driverId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO fleet_driver_notifications (driver_id, title, body, data)
     VALUES ($1, $2, $3, $4)`,
    [driverId, title, body, data ? JSON.stringify(data) : null],
  );
}

const SEED_VEHICLE_TYPES = [
  "Motorcycle",
  "Car",
  "Van",
  "Truck",
  "Bicycle",
  "Walking/Other",
] as const;
// Legacy static list kept for backwards compatibility on the existing vehicles
// CRUD. The driver-onboarding flow validates `vehicle_type` against the
// per-workspace `fleet_vehicle_types` table (controlled list, see
// ensureSeedVehicleTypes / vehicle-types CRUD endpoints).
const VEHICLE_TYPES = SEED_VEHICLE_TYPES;
type VehicleType = (typeof VEHICLE_TYPES)[number];

const DEFAULT_COUNTRY_CODE = "+961";
// E.164: leading +, 1-3 digit country code, then up to 12 more digits.
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

async function isAllowedVehicleType(
  workspaceOwnerId: string,
  name: string,
): Promise<boolean> {
  const r = await db.query<{ id: number }>(
    `SELECT id FROM fleet_vehicle_types
      WHERE workspace_owner_id = $1 AND is_active = true AND name = $2
      LIMIT 1`,
    [workspaceOwnerId, name],
  );
  return (r.rowCount ?? 0) > 0;
}

const ONBOARDING_STATUSES = ["pending", "approved", "rejected", "deactivated"] as const;
type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

const AVAILABILITY_STATUSES = ["online", "offline", "busy"] as const;
type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

const DELIVERY_STATUSES = [
  "assigned",
  "accepted",
  "picked_up",
  "out_for_delivery",
  "delivered",
  "failed_delivery",
  "returned",
  "cancelled",
] as const;

function fleetError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

async function ensureSeedVehicleTypes(workspaceOwnerId: string): Promise<void> {
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM fleet_vehicle_types WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  if (Number(existing.rows[0]?.count ?? "0") > 0) return;
  for (let i = 0; i < SEED_VEHICLE_TYPES.length; i++) {
    await db.query(
      `INSERT INTO fleet_vehicle_types (workspace_owner_id, name, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_owner_id, name) DO NOTHING`,
      [workspaceOwnerId, SEED_VEHICLE_TYPES[i], i],
    );
  }
}

const DRIVER_STATUSES = ["active", "inactive", "on_duty", "off_duty"] as const;
type DriverStatus = (typeof DRIVER_STATUSES)[number];

const ASSIGNMENT_STATUSES = [
  "pending",
  "accepted",
  "picked_up",
  "delivered",
  "failed",
  "cancelled",
] as const;

const EVENT_TYPES = [
  "assigned",
  "accepted",
  "picked_up",
  "delivered",
  "failed",
  "cancelled",
  "note",
] as const;

const DriverInputSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  phone: z
    .string()
    .min(1)
    .max(30)
    .regex(E164_REGEX, "Phone must be in E.164 format (e.g. +96170123456)"),
  country_code: z
    .string()
    .max(8)
    .regex(/^\+\d{1,4}$/, "country_code must look like +961")
    .optional(),
  taxi_company: z.string().max(200).optional().nullable(),
  vehicle_type: z.string().min(1).max(100),
  license_number: z.string().max(50).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const DriverPatchSchema = DriverInputSchema.partial().extend({
  status: z.enum(DRIVER_STATUSES).optional(),
});

const VehicleInputSchema = z.object({
  make: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  year: z.number().int().min(1900).max(2100).optional().nullable(),
  plate_number: z.string().max(30).optional().nullable(),
  vehicle_type: z.enum(VEHICLE_TYPES),
  color: z.string().max(50).optional().nullable(),
});

const AvailabilityInputSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Must be HH:MM"),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Must be HH:MM"),
});

const AssignmentInputSchema = z.object({
  driver_id: z.number().int().positive(),
  order_reference: z.string().max(200),
  pickup_address: z.string().max(500).optional().nullable(),
  delivery_address: z.string().max(500).optional().nullable(),
  scheduled_at: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const AssignmentPatchSchema = z.object({
  status: z.enum(ASSIGNMENT_STATUSES),
  notes: z.string().max(2000).optional().nullable(),
});

const DeliveryEventInputSchema = z.object({
  assignment_id: z.number().int().positive(),
  event_type: z.enum(EVENT_TYPES),
  notes: z.string().max(2000).optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
});

const ProofOfDeliveryInputSchema = z.object({
  assignment_id: z.number().int().positive(),
  recipient_name: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  signature_data: z.string().optional().nullable(),
});

const router = Router();

// ---------------------------------------------------------------------------
// Driver-token authenticated endpoints (Fleet App). Mounted before the global
// Clerk auth middleware so they can use bearer-token auth instead.
// ---------------------------------------------------------------------------

// GET /fleet/me/sse — handled by the injectable factory (default interval).
router.use(createFleetSseRouter());

router.get(
  "/fleet/me",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const result = await db.query<{
      id: number;
      first_name: string;
      last_name: string;
      phone: string | null;
      country_code: string;
      email: string | null;
      vehicle_type: string;
      onboarding_status: string;
      availability_status: string;
      status: string;
      clerk_user_id: string | null;
    }>(
      `SELECT id, first_name, last_name, phone, country_code, email,
              vehicle_type, onboarding_status, availability_status, status,
              clerk_user_id
         FROM fleet_drivers
        WHERE id = $1`,
      [dreq.driverId],
    );
    const row = result.rows[0];
    if (!row) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found");
      return;
    }
    res.json({ success: true, driver: row });
  },
);

router.patch(
  "/fleet/me/availability",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const parsed = z
      .object({ availability_status: z.enum(AVAILABILITY_STATUSES) })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    await db.query(
      `UPDATE fleet_drivers SET availability_status = $1, updated_at = now() WHERE id = $2`,
      [parsed.data.availability_status, dreq.driverId],
    );
    res.json({ success: true, availability_status: parsed.data.availability_status });
  },
);

router.get(
  "/fleet/me/orders",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const result = await db.query<{
      id: number;
      status: string;
      order_id: string | null;
      order_reference: string;
      pickup_address: string | null;
      delivery_address: string | null;
      scheduled_at: string | null;
      accepted_at: string | null;
      picked_up_at: string | null;
      delivered_at: string | null;
      notes: string | null;
      created_at: string;
      order_display_number: string | null;
      customer_name: string | null;
      order_delivery_address: Record<string, unknown> | null;
    }>(
      `SELECT a.id, a.status, a.order_id, a.order_reference, a.pickup_address,
              a.delivery_address, a.scheduled_at, a.accepted_at, a.picked_up_at,
              a.delivered_at, a.notes, a.created_at,
              o.display_order_number AS order_display_number,
              c.display_name AS customer_name,
              o.delivery_address AS order_delivery_address
         FROM fleet_driver_order_assignments a
    LEFT JOIN orders o ON o.id = a.order_id
    LEFT JOIN order_contacts ocon ON ocon.order_id = o.id AND ocon.role = 'customer'
    LEFT JOIN contacts c ON c.id = ocon.contact_id
        WHERE a.driver_id = $1
          AND a.status NOT IN ('delivered', 'cancelled', 'returned')
        ORDER BY COALESCE(a.scheduled_at, a.created_at) ASC`,
      [dreq.driverId],
    );
    const orders = result.rows.map((row) => {
      const ship = row.order_delivery_address as { city?: string } | null;
      return {
        id: row.id,
        status: row.status,
        order_id: row.order_id ?? null,
        orderNumber: row.order_display_number ?? row.order_reference,
        customerName: row.customer_name ?? null,
        address: row.delivery_address ?? null,
        city: ship?.city ?? null,
        notes: row.notes ?? null,
        items: [],
        scheduledTime: row.scheduled_at ?? null,
        packageWeight: null,
        coordinate: null,
        pickupAddress: row.pickup_address ?? null,
        acceptedAt: row.accepted_at ?? null,
        pickedUpAt: row.picked_up_at ?? null,
        createdAt: row.created_at,
      };
    });
    res.json({ success: true, orders });
  },
);

router.patch(
  "/fleet/me/orders/:id/status",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid order id");
      return;
    }
    const parsed = z.object({ status: z.enum(DELIVERY_STATUSES) }).safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const status = parsed.data.status;
    // The :id parameter is the assignment id (fleet_driver_order_assignments.id).
    const owns = await db.query<{ id: number }>(
      `SELECT id FROM fleet_driver_order_assignments
        WHERE id = $1 AND driver_id = $2`,
      [id, dreq.driverId],
    );
    if (owns.rowCount === 0 || !owns.rows[0]) {
      fleetError(res, 404, "ASSIGNMENT_NOT_FOUND", "No assignment found");
      return;
    }
    const assignmentId = owns.rows[0].id;
    const stamps: string[] = [];
    if (status === "accepted") stamps.push(`accepted_at = COALESCE(accepted_at, now())`);
    if (status === "picked_up") stamps.push(`picked_up_at = COALESCE(picked_up_at, now())`);
    if (status === "delivered") stamps.push(`delivered_at = COALESCE(delivered_at, now())`);
    const stampSql = stamps.length > 0 ? `, ${stamps.join(", ")}` : "";
    await db.query(
      `UPDATE fleet_driver_order_assignments
          SET status = $1, updated_at = now()${stampSql}
        WHERE id = $2`,
      [status, assignmentId],
    );
    await db.query(
      `INSERT INTO fleet_delivery_events (workspace_owner_id, assignment_id, event_type)
       SELECT workspace_owner_id, $1, $2 FROM fleet_driver_order_assignments WHERE id = $1`,
      [assignmentId, `status_${status}`],
    );
    res.json({ success: true, order_id: id, assignment_id: assignmentId, status });
  },
);

router.post(
  "/fleet/me/orders/:id/proof-of-delivery",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid order id");
      return;
    }
    const parsed = z
      .object({
        recipient_name: z.string().max(200).optional().nullable(),
        notes: z.string().max(2000).optional().nullable(),
        signature_data: z.string().optional().nullable(),
        image_url: z.string().url().optional().nullable(),
        latitude: z.number().min(-90).max(90).optional().nullable(),
        longitude: z.number().min(-180).max(180).optional().nullable(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    // The :id parameter is the assignment id (fleet_driver_order_assignments.id).
    const assign = await db.query<{ id: number; workspace_owner_id: string }>(
      `SELECT id, workspace_owner_id FROM fleet_driver_order_assignments
        WHERE id = $1 AND driver_id = $2`,
      [id, dreq.driverId],
    );
    if (assign.rowCount === 0 || !assign.rows[0]) {
      fleetError(res, 404, "ASSIGNMENT_NOT_FOUND", "No assignment found for that order");
      return;
    }
    const assignmentId = assign.rows[0].id;
    const d = parsed.data;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO fleet_proof_of_delivery
         (workspace_owner_id, assignment_id, driver_id, recipient_name, notes,
          signature_data, has_signature, image_url, latitude, longitude, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING id`,
      [
        assign.rows[0].workspace_owner_id,
        assignmentId,
        dreq.driverId,
        d.recipient_name ?? null,
        d.notes ?? null,
        d.signature_data ?? null,
        Boolean(d.signature_data),
        d.image_url ?? null,
        d.latitude ?? null,
        d.longitude ?? null,
      ],
    );
    await db.query(
      `UPDATE fleet_driver_order_assignments
          SET status = 'delivered', delivered_at = now(), updated_at = now()
        WHERE id = $1`,
      [assignmentId],
    );
    res.status(201).json({
      success: true,
      proof_id: inserted.rows[0].id,
      order_id: id,
      assignment_id: assignmentId,
    });
  },
);

// ---------------------------------------------------------------------------
// OTP helpers
// ---------------------------------------------------------------------------

function hashOtpCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

const OTP_REQUEST_RATE_LIMIT = {
  maxRequests: 5,
  windowMs: 15 * 60 * 1000,
};
const OTP_VERIFY_RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 15 * 60 * 1000,
};

async function otpRateLimited(
  req: Request,
  operation: "send" | "verify",
  account: string,
): Promise<boolean> {
  const limit = operation === "send" ? OTP_REQUEST_RATE_LIMIT : OTP_VERIFY_RATE_LIMIT;
  const allowed = await consumeOtpRateLimit(
    [
      `fleet:${operation}:ip:${otpRateLimitClientIp(req)}`,
      `fleet:${operation}:account:${account}`,
    ],
    limit,
  );
  return !allowed;
}

// ---------------------------------------------------------------------------
// Public: POST /fleet/auth/send-otp
// ---------------------------------------------------------------------------
router.post(
  "/fleet/auth/send-otp",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = z.object({ phone: z.string().min(1).max(30) }).safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", "Phone number is required");
      return;
    }
    const phone = parsed.data.phone.replace(/[^+0-9]/g, "");
    if (await otpRateLimited(req, "send", phone)) {
      fleetError(res, 429, "OTP_RATE_LIMITED", "Too many OTP requests, please try again later");
      return;
    }
    const driver = await db.query<{ id: number; first_name: string }>(
      `SELECT id, first_name FROM fleet_drivers
        WHERE regexp_replace(phone, '[^+0-9]', '', 'g') = $1
          AND deleted_at IS NULL
          AND onboarding_status = 'approved'
        LIMIT 1`,
      [phone],
    );
    // Always return success regardless of whether the phone belongs to an approved
    // driver — revealing which numbers are registered enables driver enumeration.
    if (!driver.rows[0]) {
      res.json({ success: true });
      return;
    }
    const recentOtp = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM driver_otp_codes
        WHERE phone_number = $1 AND used = false AND expires_at > NOW()`,
      [phone],
    );
    if (parseInt(recentOtp.rows[0]?.count ?? "0", 10) > 0) {
      fleetError(
        res,
        429,
        "OTP_RATE_LIMITED",
        "An OTP was already sent recently, please wait before requesting a new one",
      );
      return;
    }
    const code = String(crypto.randomInt(100000, 1_000_000));
    const codeHash = hashOtpCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.query(
      `UPDATE driver_otp_codes SET used = true WHERE phone_number = $1 AND used = false`,
      [phone],
    );
    await db.query(
      `INSERT INTO driver_otp_codes (phone_number, code_hash, expires_at) VALUES ($1, $2, $3)`,
      [phone, codeHash, expiresAt.toISOString()],
    );
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromPhone = process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !fromPhone) {
      if (process.env.NODE_ENV === "production") {
        logger.error({}, "Twilio env vars not configured");
        fleetError(res, 500, "SMS_CONFIG_ERROR", "SMS service is not configured");
        return;
      }
      logger.info({ phone, code }, "DEV MODE — OTP (Twilio not configured)");
      res.json({ success: true });
      return;
    }
    try {
      const twilio = (await import("twilio")).default;
      const client = twilio(accountSid, authToken);
      await client.messages.create({
        body: `Your Presentail driver code is: ${code}. It expires in 10 minutes.`,
        from: fromPhone,
        to: phone,
      });
    } catch (smsErr) {
      logger.error({ err: smsErr }, "Twilio send failed");
      fleetError(res, 500, "SMS_SEND_FAILED", "Failed to send OTP SMS");
      return;
    }
    res.json({ success: true });
  },
);

// Maximum number of wrong guesses before an OTP is invalidated.
const OTP_MAX_FAILED_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Public: POST /fleet/auth/verify-otp
// ---------------------------------------------------------------------------
router.post(
  "/fleet/auth/verify-otp",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = z
      .object({ phone: z.string().min(1).max(30), code: z.string().length(6) })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const phone = parsed.data.phone.replace(/[^+0-9]/g, "");
    if (await otpRateLimited(req, "verify", phone)) {
      fleetError(res, 429, "OTP_RATE_LIMITED", "Too many OTP attempts, please try again later");
      return;
    }

    // Look up the most-recent active OTP for this phone (without checking code_hash)
    // so we can enforce a per-OTP failed-attempt limit before comparing the hash.
    const activeOtp = await db.query<{ id: number; code_hash: string; failed_attempts: number }>(
      `SELECT id, code_hash, failed_attempts FROM driver_otp_codes
        WHERE phone_number = $1
          AND used = false
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone],
    );

    if (!activeOtp.rows[0]) {
      fleetError(res, 401, "INVALID_OR_EXPIRED_OTP", "OTP is invalid or has expired");
      return;
    }

    const otpRow = activeOtp.rows[0];

    // Reject immediately if the OTP is already locked due to too many wrong guesses.
    if (otpRow.failed_attempts >= OTP_MAX_FAILED_ATTEMPTS) {
      // Ensure the row is marked used so it cannot be retried at all.
      await db.query(`UPDATE driver_otp_codes SET used = true WHERE id = $1`, [otpRow.id]);
      fleetError(res, 401, "INVALID_OR_EXPIRED_OTP", "OTP is invalid or has expired");
      return;
    }

    const codeHash = hashOtpCode(parsed.data.code);
    if (otpRow.code_hash !== codeHash) {
      // Wrong guess — increment the counter. If this was the last allowed attempt,
      // also mark the OTP as used so it cannot be tried further.
      const newCount = otpRow.failed_attempts + 1;
      if (newCount >= OTP_MAX_FAILED_ATTEMPTS) {
        await db.query(
          `UPDATE driver_otp_codes SET failed_attempts = $1, used = true WHERE id = $2`,
          [newCount, otpRow.id],
        );
      } else {
        await db.query(`UPDATE driver_otp_codes SET failed_attempts = $1 WHERE id = $2`, [
          newCount,
          otpRow.id,
        ]);
      }
      fleetError(res, 401, "INVALID_OR_EXPIRED_OTP", "OTP is invalid or has expired");
      return;
    }

    await db.query(`UPDATE driver_otp_codes SET used = true WHERE id = $1`, [otpRow.id]);
    const driverResult = await db.query<{ id: number; first_name: string; last_name: string }>(
      `SELECT id, first_name, last_name FROM fleet_drivers
        WHERE regexp_replace(phone, '[^+0-9]', '', 'g') = $1
          AND deleted_at IS NULL
          AND onboarding_status = 'approved'
        LIMIT 1`,
      [phone],
    );
    if (!driverResult.rows[0]) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found");
      return;
    }
    const driverRow = driverResult.rows[0];
    const { plaintext, expiresAt } = await issueDriverToken(driverRow.id);
    res.json({
      success: true,
      token: plaintext,
      expiresAt: expiresAt.toISOString(),
      driverId: driverRow.id,
      driverName: `${driverRow.first_name} ${driverRow.last_name}`.trim(),
    });
  },
);

// ---------------------------------------------------------------------------
// Driver bearer token: POST /fleet/me/push-token
// ---------------------------------------------------------------------------
router.post(
  "/fleet/me/push-token",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const parsed = z
      .object({
        expo_push_token: z
          .string()
          .min(1)
          .max(500)
          .regex(
            /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/,
            "Must be a valid Expo push token (ExponentPushToken[...] or ExpoPushToken[...])",
          ),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    await db.query(
      `UPDATE fleet_drivers SET expo_push_token = $1, updated_at = now() WHERE id = $2`,
      [parsed.data.expo_push_token, dreq.driverId],
    );
    res.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// Driver bearer token: GET /fleet/me/transactions
// ---------------------------------------------------------------------------
router.get(
  "/fleet/me/transactions",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const offset = (page - 1) * limit;
    const [result, countResult] = await Promise.all([
      db.query(
        `SELECT id, driver_id, type, amount_cents, description, order_id, date, created_at
           FROM fleet_driver_transactions
          WHERE driver_id = $1
          ORDER BY date DESC, created_at DESC
          LIMIT $2 OFFSET $3`,
        [dreq.driverId, limit, offset],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM fleet_driver_transactions WHERE driver_id = $1`,
        [dreq.driverId],
      ),
    ]);
    res.json({
      success: true,
      transactions: result.rows,
      total: Number(countResult.rows[0]?.count ?? 0),
      page,
      limit,
    });
  },
);

// ---------------------------------------------------------------------------
// Driver bearer token: GET /fleet/me/notifications
// Returns the last 50 unread notifications for the authenticated driver.
// ---------------------------------------------------------------------------
router.get(
  "/fleet/me/notifications",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const result = await db.query(
      `SELECT id, title, body, data, read_at, created_at
         FROM fleet_driver_notifications
        WHERE driver_id = $1 AND read_at IS NULL
        ORDER BY created_at DESC
        LIMIT 50`,
      [dreq.driverId],
    );
    const unreadCount = result.rows.length;
    res.json({ success: true, notifications: result.rows, unread_count: unreadCount });
  },
);

// ---------------------------------------------------------------------------
// Driver bearer token: PATCH /fleet/me/notifications/:id/read
// Marks a single notification as read.
// ---------------------------------------------------------------------------
router.patch(
  "/fleet/me/notifications/:id/read",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    const dreq = driverAuthed(req);
    const notificationId = Number(req.params.id);
    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid notification id");
      return;
    }
    const result = await db.query(
      `UPDATE fleet_driver_notifications
          SET read_at = now()
        WHERE id = $1 AND driver_id = $2 AND read_at IS NULL
        RETURNING id`,
      [notificationId, dreq.driverId],
    );
    if ((result.rowCount ?? 0) === 0) {
      fleetError(res, 404, "NOT_FOUND", "Notification not found or already read");
      return;
    }
    res.json({ success: true });
  },
);

router.use(requireAuth, resolveWorkspace);

/**
 * Gate for sensitive fleet/driver administration (create/delete drivers,
 * token rotation, vehicle types, fleet settings). Owner-only.
 */
function ownerOnly(
  wreq: ReturnType<typeof workspace>,
  res: Parameters<Parameters<typeof router.post>[1]>[1],
): boolean {
  if (wreq.workspaceRole === "owner") return true;
  res
    .status(403)
    .json({ error: "Only the workspace owner can perform this action" });
  return false;
}

/**
 * Gate for the driver actions reachable from the order edit / fulfillment flow:
 * the driver picker (GET /fleet/drivers), approving driver onboarding, and
 * assigning / unassigning a driver to a native order. Owners always pass;
 * members pass when their role grants the Orders page or the Fleet page.
 * Sensitive fleet admin stays owner-only via {@link ownerOnly}.
 */
function fleetOrderAccess(
  wreq: ReturnType<typeof workspace>,
  res: Parameters<Parameters<typeof router.post>[1]>[1],
): boolean {
  if (hasPageAccess(wreq, "orders") || hasPageAccess(wreq, "fleet")) return true;
  res
    .status(403)
    .json({ error: "You do not have access to driver assignment" });
  return false;
}

// ---------------------------------------------------------------------------
// Admin (Clerk session, owner-only): POST /fleet/me/transactions
// ---------------------------------------------------------------------------
router.post(
  "/fleet/me/transactions",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const parsed = z
      .object({
        driver_id: z.number().int().positive(),
        type: z.enum(["earning", "bonus", "deduction"]),
        amount_cents: z.number().int(),
        description: z.string().min(1).max(500),
        order_id: z.string().max(100).optional().nullable(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const d = parsed.data;
    const driverCheck = await db.query<{ id: number }>(
      `SELECT id FROM fleet_drivers
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [d.driver_id, wreq.workspaceOwnerId],
    );
    if (!driverCheck.rows[0]) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found in this workspace");
      return;
    }
    const result = await db.query<{ id: string }>(
      `INSERT INTO fleet_driver_transactions
         (driver_id, type, amount_cents, description, order_id, date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [d.driver_id, d.type, d.amount_cents, d.description, d.order_id ?? null, d.date],
    );
    res.status(201).json({ success: true, id: result.rows[0]?.id });
  },
);

router.get("/fleet/docs", (_req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fleet API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/api/fleet/spec",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
      filter: "Fleet",
    });
  </script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

router.get("/fleet/spec", (_req, res) => {
  try {
    const specPath = resolve(
      new URL(import.meta.url).pathname,
      "../../../../../../lib/api-spec/openapi.yaml",
    );
    const spec = readFileSync(specPath, "utf-8");
    res.setHeader("Content-Type", "application/yaml");
    res.send(spec);
  } catch (err) {
    logger.warn({ err }, "Could not read openapi.yaml for fleet/spec");
    res.status(404).json({ error: "Spec not found" });
  }
});

router.get("/fleet/drivers", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const status = req.query.status as DriverStatus | undefined;
  const onboardingStatus = req.query.onboarding_status as OnboardingStatus | undefined;
  const availability = req.query.availability_status as AvailabilityStatus | undefined;
  const vehicleType = (req.query.vehicle_type as string | undefined)?.trim();
  const taxiCompanyFilter = (req.query.taxi_company as string | undefined)?.trim();
  const activeRaw = req.query.active as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();

  const conditions: string[] = ["workspace_owner_id = $1", "deleted_at IS NULL"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (status && DRIVER_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (onboardingStatus && ONBOARDING_STATUSES.includes(onboardingStatus)) {
    params.push(onboardingStatus);
    conditions.push(`onboarding_status = $${params.length}`);
  }
  if (availability && AVAILABILITY_STATUSES.includes(availability)) {
    params.push(availability);
    conditions.push(`availability_status = $${params.length}`);
  }
  if (vehicleType) {
    params.push(vehicleType);
    conditions.push(`vehicle_type = $${params.length}`);
  }
  if (taxiCompanyFilter) {
    params.push(taxiCompanyFilter);
    conditions.push(`taxi_company = $${params.length}`);
  }
  if (activeRaw === "true") {
    conditions.push(`status = 'active' AND onboarding_status = 'approved'`);
  } else if (activeRaw === "false") {
    conditions.push(`(status <> 'active' OR onboarding_status <> 'approved')`);
  }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conditions.push(
      `(first_name ILIKE $${n} OR last_name ILIKE $${n} OR taxi_company ILIKE $${n} OR phone ILIKE $${n})`,
    );
  }

  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, phone, country_code, taxi_company, vehicle_type,
              license_number, status, onboarding_status, availability_status,
              notes, created_at, updated_at
         FROM fleet_drivers
        WHERE ${conditions.join(" AND ")}
        ORDER BY first_name, last_name`,
      params,
    );
    res.json({ success: true, drivers: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list fleet drivers");
    fleetError(res, 500, "INTERNAL", "Failed to list drivers");
  }
});

router.post("/fleet/drivers", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const parse = DriverInputSchema.safeParse(req.body);
  if (!parse.success) {
    fleetError(
      res,
      400,
      "VALIDATION_ERROR",
      parse.error.errors[0]?.message ?? "Invalid input",
    );
    return;
  }
  const d = parse.data;

  // Normalise phone: strip everything except + and digits.
  const normalizedPhone = d.phone ? d.phone.replace(/[^+0-9]/g, "") : null;

  // Ensure the seed list exists, then validate vehicle_type against the DB.
  await ensureSeedVehicleTypes(wreq.workspaceOwnerId);
  if (!(await isAllowedVehicleType(wreq.workspaceOwnerId, d.vehicle_type))) {
    fleetError(
      res,
      400,
      "INVALID_VEHICLE_TYPE",
      `Vehicle type "${d.vehicle_type}" is not in the workspace's allowed list`,
    );
    return;
  }

  const taxiCompanyNormalized = d.taxi_company?.trim() || null;

  // Duplicate phone check — authoritative server-side guard before insert.
  if (normalizedPhone) {
    const dupe = await db.query<{ id: number }>(
      `SELECT id FROM fleet_drivers
        WHERE workspace_owner_id = $1
          AND regexp_replace(phone, '[^+0-9]', '', 'g') = $2
          AND deleted_at IS NULL
        LIMIT 1`,
      [wreq.workspaceOwnerId, normalizedPhone],
    );
    if ((dupe.rowCount ?? 0) > 0) {
      res.status(409).json({
        success: false,
        code: "DUPLICATE_PHONE",
        message: "A driver with this phone number already exists.",
      });
      return;
    }
  }

  let newDriverId: number | null = null;
  try {
    const result = await db.query<{ id: number }>(
      `INSERT INTO fleet_drivers
         (workspace_owner_id, first_name, last_name, phone, country_code,
          taxi_company, vehicle_type, license_number, notes, status, onboarding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 'pending')
       RETURNING id, first_name, last_name, phone, country_code, taxi_company, vehicle_type,
                 license_number, status, onboarding_status, availability_status,
                 notes, created_at, updated_at`,
      [
        wreq.workspaceOwnerId,
        d.first_name,
        d.last_name,
        normalizedPhone,
        d.country_code ?? DEFAULT_COUNTRY_CODE,
        taxiCompanyNormalized,
        d.vehicle_type,
        d.license_number ?? null,
        d.notes ?? null,
      ],
    );
    const driverRow = result.rows[0];
    if (!driverRow) {
      fleetError(res, 500, "INTERNAL", "Failed to create driver");
      return;
    }
    newDriverId = driverRow.id;

    // Provision (or reuse) a Clerk user for this driver's phone number.
    // If this fails, roll back the driver row so we never have an orphaned
    // DB record without a Clerk link.
    if (normalizedPhone) {
      let clerkUserId: string;
      try {
        clerkUserId = await syncDriverToClerk(newDriverId, normalizedPhone);
      } catch (clerkErr) {
        logger.error({ err: clerkErr, driverId: newDriverId }, "Clerk sync failed — rolling back driver row");
        await db.query(`DELETE FROM fleet_drivers WHERE id = $1`, [newDriverId]);
        fleetError(
          res,
          500,
          "CLERK_SYNC_FAILED",
          "Driver account created but Clerk provisioning failed. Please try again.",
        );
        return;
      }
      try {
        await db.query(
          `UPDATE fleet_drivers SET clerk_user_id = $1, updated_at = now() WHERE id = $2`,
          [clerkUserId, newDriverId],
        );
        (driverRow as Record<string, unknown>).clerk_user_id = clerkUserId;
      } catch (updateErr) {
        // If the clerk_user_id update fails (e.g. unique constraint — Clerk user
        // already linked to another driver), roll back the driver row too so we
        // never leave an orphan without Clerk linkage.
        logger.error({ err: updateErr, driverId: newDriverId, clerkUserId }, "clerk_user_id update failed — rolling back driver row");
        await db.query(`DELETE FROM fleet_drivers WHERE id = $1`, [newDriverId]);
        const isClerkConflict =
          typeof updateErr === "object" &&
          updateErr !== null &&
          (updateErr as { code?: string }).code === "23505" &&
          (updateErr as { constraint?: string }).constraint?.includes("clerk_user_id");
        if (isClerkConflict) {
          fleetError(
            res,
            409,
            "CLERK_USER_ALREADY_LINKED",
            "This Clerk user is already linked to another driver in this workspace.",
          );
        } else {
          fleetError(res, 500, "INTERNAL", "Failed to save Clerk link. Please try again.");
        }
        return;
      }
    }

    res.status(201).json({
      success: true,
      driver: driverRow,
      message: "Driver created successfully. They can now log in to the driver app using their phone number.",
    });
  } catch (err) {
    // Catch concurrent-insert unique-index violation (pg error 23505).
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505" &&
      (err as { constraint?: string }).constraint?.includes("phone")
    ) {
      res.status(409).json({
        success: false,
        code: "DUPLICATE_PHONE",
        message: "A driver with this phone number already exists.",
      });
      return;
    }
    logger.error({ err }, "Failed to create fleet driver");
    fleetError(res, 500, "INTERNAL", "Failed to create driver");
  }
});

router.get("/fleet/drivers/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  try {
    const result = await db.query(
      `SELECT id, first_name, last_name, phone, country_code, taxi_company, vehicle_type,
              license_number, status, onboarding_status, availability_status,
              clerk_user_id, notes, created_at, updated_at
         FROM fleet_drivers
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [id, wreq.workspaceOwnerId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.json({ driver: result.rows[0] });
  } catch (err) {
    logger.error({ err, id }, "Failed to fetch fleet driver");
    res.status(500).json({ error: "Failed to fetch driver" });
  }
});

router.patch("/fleet/drivers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  const parse = DriverPatchSchema.safeParse(req.body);
  if (!parse.success) {
    fleetError(
      res,
      400,
      "VALIDATION_ERROR",
      parse.error.errors[0]?.message ?? "Invalid input",
    );
    return;
  }
  const d = parse.data;

  if (d.vehicle_type !== undefined) {
    await ensureSeedVehicleTypes(wreq.workspaceOwnerId);
    if (!(await isAllowedVehicleType(wreq.workspaceOwnerId, d.vehicle_type))) {
      fleetError(
        res,
        400,
        "INVALID_VEHICLE_TYPE",
        `Vehicle type "${d.vehicle_type}" is not in the workspace's allowed list`,
      );
      return;
    }
  }

  // Duplicate phone check — exclude the driver being edited.
  if (d.phone) {
    const normalizedPhone = d.phone.replace(/[^+0-9]/g, "");
    if (normalizedPhone) {
      const dupe = await db.query<{ id: number }>(
        `SELECT id FROM fleet_drivers
          WHERE workspace_owner_id = $1
            AND regexp_replace(phone, '[^+0-9]', '', 'g') = $2
            AND id <> $3
            AND deleted_at IS NULL
          LIMIT 1`,
        [wreq.workspaceOwnerId, normalizedPhone, id],
      );
      if ((dupe.rowCount ?? 0) > 0) {
        res.status(409).json({
          success: false,
          code: "DUPLICATE_PHONE",
          message: "A driver with this phone number already exists.",
        });
        return;
      }
    }
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id, wreq.workspaceOwnerId];

  const fields: Array<[string, unknown]> = [
    ["first_name", d.first_name],
    ["last_name", d.last_name],
    ["phone", d.phone],
    ["country_code", d.country_code],
    ["taxi_company", d.taxi_company !== undefined ? (d.taxi_company?.trim() || null) : undefined],
    ["vehicle_type", d.vehicle_type],
    ["license_number", d.license_number],
    ["notes", d.notes],
    ["status", d.status],
  ];
  for (const [col, val] of fields) {
    if (val !== undefined) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
  }

  if (sets.length === 1) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  try {
    const result = await db.query(
      `UPDATE fleet_drivers
          SET ${sets.join(", ")}
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL
        RETURNING id, first_name, last_name, phone, taxi_company, vehicle_type, license_number, status, notes, created_at, updated_at`,
      params,
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.json({ driver: result.rows[0] });
  } catch (err) {
    logger.error({ err, id }, "Failed to update fleet driver");
    res.status(500).json({ error: "Failed to update driver" });
  }
});

router.delete("/fleet/drivers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  try {
    const result = await db.query(
      `UPDATE fleet_drivers
          SET deleted_at = now(), status = 'inactive', updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [id, wreq.workspaceOwnerId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, id }, "Failed to deactivate fleet driver");
    res.status(500).json({ error: "Failed to deactivate driver" });
  }
});

router.post("/fleet/drivers/:id/link-clerk", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  try {
    const driverResult = await db.query<{
      id: number;
      phone: string | null;
      clerk_user_id: string | null;
    }>(
      `SELECT id, phone, clerk_user_id FROM fleet_drivers
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [id, wreq.workspaceOwnerId],
    );
    const driver = driverResult.rows[0];
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    if (!driver.phone) {
      res.status(400).json({ error: "Driver has no phone number — cannot link to Clerk." });
      return;
    }

    const clerkUserId = await syncDriverToClerk(id, driver.phone);
    await db.query(
      `UPDATE fleet_drivers SET clerk_user_id = $1, updated_at = now() WHERE id = $2`,
      [clerkUserId, id],
    );

    res.json({ success: true, clerk_user_id: clerkUserId });
  } catch (err) {
    logger.error({ err, id }, "Failed to link Clerk user to driver");
    res.status(500).json({ error: "Failed to link Clerk user" });
  }
});

router.get("/fleet/drivers/:id/vehicles", async (req, res) => {
  const wreq = workspace(req);
  const driverId = parseInt(req.params.id, 10);
  if (Number.isNaN(driverId)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  try {
    const driverCheck = await db.query(
      `SELECT id FROM fleet_drivers WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [driverId, wreq.workspaceOwnerId],
    );
    if (!driverCheck.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const result = await db.query(
      `SELECT id, driver_id, make, model, year, plate_number, vehicle_type, color, created_at
         FROM fleet_driver_vehicles
        WHERE driver_id = $1
        ORDER BY created_at DESC`,
      [driverId],
    );
    res.json({ vehicles: result.rows });
  } catch (err) {
    logger.error({ err, driverId }, "Failed to list driver vehicles");
    res.status(500).json({ error: "Failed to list vehicles" });
  }
});

router.post("/fleet/drivers/:id/vehicles", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const driverId = parseInt(req.params.id, 10);
  if (Number.isNaN(driverId)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  const parse = VehicleInputSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", issues: parse.error.issues });
    return;
  }
  const v = parse.data;

  try {
    const driverCheck = await db.query(
      `SELECT id FROM fleet_drivers WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [driverId, wreq.workspaceOwnerId],
    );
    if (!driverCheck.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const result = await db.query(
      `INSERT INTO fleet_driver_vehicles (driver_id, make, model, year, plate_number, vehicle_type, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, driver_id, make, model, year, plate_number, vehicle_type, color, created_at`,
      [driverId, v.make ?? null, v.model ?? null, v.year ?? null, v.plate_number ?? null, v.vehicle_type, v.color ?? null],
    );
    res.status(201).json({ vehicle: result.rows[0] });
  } catch (err) {
    logger.error({ err, driverId }, "Failed to add driver vehicle");
    res.status(500).json({ error: "Failed to add vehicle" });
  }
});

router.delete("/fleet/drivers/:id/vehicles/:vehicleId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const driverId = parseInt(req.params.id, 10);
  const vehicleId = parseInt(req.params.vehicleId, 10);
  if (Number.isNaN(driverId) || Number.isNaN(vehicleId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const result = await db.query(
      `DELETE FROM fleet_driver_vehicles
        WHERE id = $1 AND driver_id = $2
        RETURNING id`,
      [vehicleId, driverId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, vehicleId }, "Failed to delete driver vehicle");
    res.status(500).json({ error: "Failed to delete vehicle" });
  }
});

router.get("/fleet/drivers/:id/availability", async (req, res) => {
  const wreq = workspace(req);
  const driverId = parseInt(req.params.id, 10);
  if (Number.isNaN(driverId)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  try {
    const driverCheck = await db.query(
      `SELECT id FROM fleet_drivers WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [driverId, wreq.workspaceOwnerId],
    );
    if (!driverCheck.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const result = await db.query(
      `SELECT id, driver_id, day_of_week, start_time, end_time
         FROM fleet_driver_availability
        WHERE driver_id = $1
        ORDER BY day_of_week, start_time`,
      [driverId],
    );
    res.json({ availability: result.rows });
  } catch (err) {
    logger.error({ err, driverId }, "Failed to list driver availability");
    res.status(500).json({ error: "Failed to list availability" });
  }
});

router.post("/fleet/drivers/:id/availability", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const driverId = parseInt(req.params.id, 10);
  if (Number.isNaN(driverId)) {
    res.status(400).json({ error: "Invalid driver id" });
    return;
  }

  const parse = AvailabilityInputSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", issues: parse.error.issues });
    return;
  }
  const a = parse.data;

  try {
    const driverCheck = await db.query(
      `SELECT id FROM fleet_drivers WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [driverId, wreq.workspaceOwnerId],
    );
    if (!driverCheck.rows[0]) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const result = await db.query(
      `INSERT INTO fleet_driver_availability (driver_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (driver_id, day_of_week) DO UPDATE
         SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time
       RETURNING id, driver_id, day_of_week, start_time, end_time`,
      [driverId, a.day_of_week, a.start_time, a.end_time],
    );
    res.status(201).json({ availability: result.rows[0] });
  } catch (err) {
    logger.error({ err, driverId }, "Failed to set driver availability");
    res.status(500).json({ error: "Failed to set availability" });
  }
});

router.get("/fleet/taxi-companies", async (req, res) => {
  const wreq = workspace(req);
  try {
    const result = await db.query<{ taxi_company: string }>(
      `SELECT DISTINCT taxi_company
         FROM fleet_drivers
        WHERE workspace_owner_id = $1
          AND deleted_at IS NULL
          AND taxi_company IS NOT NULL
          AND taxi_company <> ''
        ORDER BY taxi_company ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, taxi_companies: result.rows.map((r) => r.taxi_company) });
  } catch (err) {
    logger.error({ err }, "Failed to list taxi companies");
    fleetError(res, 500, "INTERNAL", "Failed to list taxi companies");
  }
});

router.get("/fleet/assignments", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const status = req.query.status as string | undefined;
  const driverIdParam = req.query.driver_id as string | undefined;

  const conditions: string[] = ["fda.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (status && ASSIGNMENT_STATUSES.includes(status as (typeof ASSIGNMENT_STATUSES)[number])) {
    params.push(status);
    conditions.push(`fda.status = $${params.length}`);
  }
  if (driverIdParam) {
    const did = parseInt(driverIdParam, 10);
    if (!Number.isNaN(did)) {
      params.push(did);
      conditions.push(`fda.driver_id = $${params.length}`);
    }
  }

  try {
    const result = await db.query(
      `SELECT fda.id, fda.driver_id, fda.order_reference, fda.pickup_address, fda.delivery_address,
              fda.status, fda.scheduled_at, fda.notes, fda.created_at, fda.updated_at,
              fd.first_name, fd.last_name
         FROM fleet_driver_order_assignments fda
         JOIN fleet_drivers fd ON fd.id = fda.driver_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY fda.created_at DESC`,
      params,
    );
    res.json({ assignments: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list fleet assignments");
    res.status(500).json({ error: "Failed to list assignments" });
  }
});

router.post("/fleet/assignments", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const parse = AssignmentInputSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", issues: parse.error.issues });
    return;
  }
  const a = parse.data;

  try {
    const driverCheck = await db.query(
      `SELECT id FROM fleet_drivers WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL AND status != 'inactive'`,
      [a.driver_id, wreq.workspaceOwnerId],
    );
    if (!driverCheck.rows[0]) {
      res.status(404).json({ error: "Driver not found or inactive" });
      return;
    }
    const result = await db.query(
      `INSERT INTO fleet_driver_order_assignments
         (workspace_owner_id, driver_id, order_reference, pickup_address, delivery_address, scheduled_at, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id, driver_id, order_reference, pickup_address, delivery_address, status, scheduled_at, notes, created_at, updated_at`,
      [
        wreq.workspaceOwnerId,
        a.driver_id,
        a.order_reference,
        a.pickup_address ?? null,
        a.delivery_address ?? null,
        a.scheduled_at ?? null,
        a.notes ?? null,
      ],
    );
    res.status(201).json({ assignment: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create fleet assignment");
    res.status(500).json({ error: "Failed to create assignment" });
  }
});

router.patch("/fleet/assignments/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid assignment id" });
    return;
  }

  const parse = AssignmentPatchSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", issues: parse.error.issues });
    return;
  }
  const a = parse.data;

  try {
    const result = await db.query(
      `UPDATE fleet_driver_order_assignments
          SET status = $3, notes = COALESCE($4, notes), updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2
        RETURNING id, driver_id, order_reference, pickup_address, delivery_address, status, scheduled_at, notes, created_at, updated_at`,
      [id, wreq.workspaceOwnerId, a.status, a.notes ?? null],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    res.json({ assignment: result.rows[0] });
  } catch (err) {
    logger.error({ err, id }, "Failed to update fleet assignment");
    res.status(500).json({ error: "Failed to update assignment" });
  }
});

router.get("/fleet/delivery-events", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const assignmentIdParam = req.query.assignment_id as string | undefined;

  const conditions: string[] = ["fde.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (assignmentIdParam) {
    const aid = parseInt(assignmentIdParam, 10);
    if (!Number.isNaN(aid)) {
      params.push(aid);
      conditions.push(`fde.assignment_id = $${params.length}`);
    }
  }

  try {
    const result = await db.query(
      `SELECT fde.id, fde.assignment_id, fde.event_type, fde.notes, fde.lat, fde.lng, fde.occurred_at
         FROM fleet_delivery_events fde
        WHERE ${conditions.join(" AND ")}
        ORDER BY fde.occurred_at DESC`,
      params,
    );
    res.json({ events: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list delivery events");
    res.status(500).json({ error: "Failed to list events" });
  }
});

router.post("/fleet/delivery-events", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const parse = DeliveryEventInputSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", issues: parse.error.issues });
    return;
  }
  const e = parse.data;

  try {
    const assignmentCheck = await db.query(
      `SELECT id FROM fleet_driver_order_assignments WHERE id = $1 AND workspace_owner_id = $2`,
      [e.assignment_id, wreq.workspaceOwnerId],
    );
    if (!assignmentCheck.rows[0]) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    const result = await db.query(
      `INSERT INTO fleet_delivery_events (workspace_owner_id, assignment_id, event_type, notes, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, assignment_id, event_type, notes, lat, lng, occurred_at`,
      [wreq.workspaceOwnerId, e.assignment_id, e.event_type, e.notes ?? null, e.lat ?? null, e.lng ?? null],
    );
    res.status(201).json({ event: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create delivery event");
    res.status(500).json({ error: "Failed to create event" });
  }
});

router.get("/fleet/proof-of-delivery", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const assignmentIdParam = req.query.assignment_id as string | undefined;

  const conditions: string[] = ["fpod.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (assignmentIdParam) {
    const aid = parseInt(assignmentIdParam, 10);
    if (!Number.isNaN(aid)) {
      params.push(aid);
      conditions.push(`fpod.assignment_id = $${params.length}`);
    }
  }

  try {
    const result = await db.query(
      `SELECT fpod.id, fpod.assignment_id, fpod.recipient_name, fpod.notes, fpod.has_signature, fpod.created_at
         FROM fleet_proof_of_delivery fpod
        WHERE ${conditions.join(" AND ")}
        ORDER BY fpod.created_at DESC`,
      params,
    );
    res.json({ proofs: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list proof of delivery" );
    res.status(500).json({ error: "Failed to list proofs" });
  }
});

router.post("/fleet/proof-of-delivery", async (req, res) => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const parse = ProofOfDeliveryInputSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Invalid input", issues: parse.error.issues });
    return;
  }
  const p = parse.data;

  try {
    const assignmentCheck = await db.query(
      `SELECT id FROM fleet_driver_order_assignments WHERE id = $1 AND workspace_owner_id = $2`,
      [p.assignment_id, wreq.workspaceOwnerId],
    );
    if (!assignmentCheck.rows[0]) {
      res.status(404).json({ error: "Assignment not found" });
      return;
    }
    const result = await db.query(
      `INSERT INTO fleet_proof_of_delivery
         (workspace_owner_id, assignment_id, recipient_name, notes, signature_data, has_signature)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, assignment_id, recipient_name, notes, has_signature, created_at`,
      [
        wreq.workspaceOwnerId,
        p.assignment_id,
        p.recipient_name ?? null,
        p.notes ?? null,
        p.signature_data ?? null,
        !!p.signature_data,
      ],
    );
    res.status(201).json({ proof: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create proof of delivery");
    res.status(500).json({ error: "Failed to create proof" });
  }
});

// ---------------------------------------------------------------------------
// Admin: Driver onboarding lifecycle (status + token issuance/revocation)
// ---------------------------------------------------------------------------

// Shared implementation used by both PATCH /fleet/drivers/:id/status (the
// documented contract path) and PATCH /fleet/drivers/:id/onboarding-status
// (legacy alias). Accepts a body of `{onboarding_status, deactivation_reason?}`
// or `{status, deactivation_reason?}`.
const driverOnboardingStatusHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const body = (req.body ?? {}) as {
    status?: string;
    onboarding_status?: string;
    deactivation_reason?: string | null;
  };
  const normalized = {
    onboarding_status: body.onboarding_status ?? body.status,
    deactivation_reason: body.deactivation_reason ?? null,
  };
    const wreq = workspace(req);
    if (!fleetOrderAccess(wreq, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid driver id");
      return;
    }
    const parsed = z
      .object({
        onboarding_status: z.enum(ONBOARDING_STATUSES),
        deactivation_reason: z.string().max(500).optional().nullable(),
      })
      .safeParse(normalized);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const status: OnboardingStatus = parsed.data.onboarding_status;
    const owns = await db.query<{ id: number; current: string }>(
      `SELECT id, onboarding_status AS current FROM fleet_drivers
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [id, wreq.workspaceOwnerId],
    );
    if (owns.rowCount === 0) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found");
      return;
    }

    let issuedToken: string | null = null;
    if (status === "approved") {
      // Only issue a token when the driver is moving INTO approved.
      if (owns.rows[0].current !== "approved") {
        const token = await issueDriverToken(id);
        issuedToken = token.plaintext;
      }
      await db.query(
        `UPDATE fleet_drivers
            SET onboarding_status = 'approved',
                deactivated_at = NULL,
                deactivation_reason = NULL,
                status = 'active',
                updated_at = now()
          WHERE id = $1`,
        [id],
      );
    } else if (status === "deactivated" || status === "rejected") {
      await revokeDriverTokens(id);
      await db.query(
        `UPDATE fleet_drivers
            SET onboarding_status = $2,
                deactivated_at = now(),
                deactivation_reason = $3,
                status = 'inactive',
                availability_status = 'offline',
                updated_at = now()
          WHERE id = $1`,
        [id, status, parsed.data.deactivation_reason ?? null],
      );
    } else {
      // pending
      await revokeDriverTokens(id);
      await db.query(
        `UPDATE fleet_drivers
            SET onboarding_status = 'pending',
                updated_at = now()
          WHERE id = $1`,
        [id],
      );
    }

    res.json({
      success: true,
      id,
      onboarding_status: status,
      // The plaintext token is returned exactly once (on approval). It is never
      // stored or returned by any other endpoint.
      token: issuedToken,
    });
};

router.patch("/fleet/drivers/:id/status", driverOnboardingStatusHandler);
router.patch("/fleet/drivers/:id/onboarding-status", driverOnboardingStatusHandler);

router.patch(
  "/fleet/drivers/:id/availability",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid driver id");
      return;
    }
    const parsed = z
      .object({ availability_status: z.enum(AVAILABILITY_STATUSES) })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const result = await db.query(
      `UPDATE fleet_drivers
          SET availability_status = $1, updated_at = now()
        WHERE id = $2 AND workspace_owner_id = $3 AND deleted_at IS NULL
        RETURNING id`,
      [parsed.data.availability_status, id, wreq.workspaceOwnerId],
    );
    if (result.rowCount === 0) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found");
      return;
    }
    res.json({ success: true, id, availability_status: parsed.data.availability_status });
  },
);

router.post(
  "/fleet/drivers/:id/rotate-token",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid driver id");
      return;
    }
    const owns = await db.query(
      `SELECT id, onboarding_status FROM fleet_drivers
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [id, wreq.workspaceOwnerId],
    );
    if (owns.rowCount === 0) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found");
      return;
    }
    if (owns.rows[0].onboarding_status !== "approved") {
      fleetError(res, 400, "NOT_APPROVED", "Driver must be approved before issuing a token");
      return;
    }
    const token = await issueDriverToken(id);
    res.json({ success: true, id, token: token.plaintext });
  },
);

// ---------------------------------------------------------------------------
// Admin: Vehicle Types CRUD
// ---------------------------------------------------------------------------

router.get(
  "/fleet/vehicle-types",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    await ensureSeedVehicleTypes(wreq.workspaceOwnerId);
    const result = await db.query(
      `SELECT id, name, is_active, sort_order, created_at, updated_at
         FROM fleet_vehicle_types
        WHERE workspace_owner_id = $1
        ORDER BY sort_order, name`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, vehicle_types: result.rows });
  },
);

router.post(
  "/fleet/vehicle-types",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const parsed = z
      .object({
        name: z.string().min(1).max(100).trim(),
        sort_order: z.number().int().min(0).max(9999).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    try {
      const result = await db.query(
        `INSERT INTO fleet_vehicle_types (workspace_owner_id, name, sort_order)
         VALUES ($1, $2, $3)
         RETURNING id, name, is_active, sort_order, created_at, updated_at`,
        [wreq.workspaceOwnerId, parsed.data.name, parsed.data.sort_order ?? 0],
      );
      res.status(201).json({ success: true, vehicle_type: result.rows[0] });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "23505") {
        fleetError(res, 409, "DUPLICATE", "A vehicle type with that name already exists");
        return;
      }
      throw err;
    }
  },
);

router.patch(
  "/fleet/vehicle-types/:id",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid id");
      return;
    }
    const parsed = z
      .object({
        name: z.string().min(1).max(100).trim().optional(),
        is_active: z.boolean().optional(),
        sort_order: z.number().int().min(0).max(9999).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const updates: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.name !== undefined) {
      params.push(parsed.data.name);
      updates.push(`name = $${params.length}`);
    }
    if (parsed.data.is_active !== undefined) {
      params.push(parsed.data.is_active);
      updates.push(`is_active = $${params.length}`);
    }
    if (parsed.data.sort_order !== undefined) {
      params.push(parsed.data.sort_order);
      updates.push(`sort_order = $${params.length}`);
    }
    if (updates.length === 0) {
      fleetError(res, 400, "VALIDATION_ERROR", "No updates provided");
      return;
    }
    updates.push(`updated_at = now()`);
    params.push(id, wreq.workspaceOwnerId);
    try {
      const result = await db.query(
        `UPDATE fleet_vehicle_types SET ${updates.join(", ")}
          WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
          RETURNING id, name, is_active, sort_order, created_at, updated_at`,
        params,
      );
      if (result.rowCount === 0) {
        fleetError(res, 404, "NOT_FOUND", "Vehicle type not found");
        return;
      }
      res.json({ success: true, vehicle_type: result.rows[0] });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "23505") {
        fleetError(res, 409, "DUPLICATE", "A vehicle type with that name already exists");
        return;
      }
      throw err;
    }
  },
);

router.delete(
  "/fleet/vehicle-types/:id",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fleetError(res, 400, "INVALID_ID", "Invalid id");
      return;
    }
    const result = await db.query(
      `UPDATE fleet_vehicle_types
          SET is_active = false, updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2
        RETURNING id`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rowCount === 0) {
      fleetError(res, 404, "NOT_FOUND", "Vehicle type not found");
      return;
    }
    res.json({ success: true, id });
  },
);

// ---------------------------------------------------------------------------
// Admin: Orders (over native orders table) — list/get/assign-driver/status
// ---------------------------------------------------------------------------

router.get(
  "/fleet/orders",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const driverId = req.query.driver_id ? Number(req.query.driver_id) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const conditions: string[] = [
      `a.workspace_owner_id = $1`,
    ];
    const params: unknown[] = [wreq.workspaceOwnerId];
    if (status && DELIVERY_STATUSES.includes(status as (typeof DELIVERY_STATUSES)[number])) {
      params.push(status);
      conditions.push(`a.status = $${params.length}`);
    }
    if (driverId && Number.isInteger(driverId)) {
      params.push(driverId);
      conditions.push(`a.driver_id = $${params.length}`);
    }
    params.push(limit);
    const result = await db.query(
      `SELECT o.id AS order_id, o.display_order_number, o.status AS order_status,
              o.totals, o.ordered_at,
              c.display_name AS customer_name, c.email AS customer_email,
              o.delivery_address,
              a.id, a.driver_id, a.status AS delivery_status,
              a.order_reference, a.scheduled_at, a.delivered_at,
              d.first_name AS driver_first_name, d.last_name AS driver_last_name
         FROM fleet_driver_order_assignments a
    LEFT JOIN orders o ON o.id = a.order_id
    LEFT JOIN order_contacts ocon ON ocon.order_id = o.id AND ocon.role = 'customer'
    LEFT JOIN contacts c ON c.id = ocon.contact_id
    LEFT JOIN fleet_drivers d ON d.id = a.driver_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ success: true, orders: result.rows });
  },
);

// Reusable handler — exposed both as PATCH (canonical, RESTful update of the
// order's assigned driver) and POST (legacy alias, kept for clients that
// already shipped against the earlier draft of this endpoint).
const assignDriverHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const wreq = workspace(req);
    if (!fleetOrderAccess(wreq, res)) return;
    const orderId = req.params.id; // UUID from orders.id
    if (!orderId || typeof orderId !== "string" || orderId.length < 4) {
      fleetError(res, 400, "INVALID_ID", "Invalid order id");
      return;
    }
    const parsed = z
      .object({
        driver_id: z.number().int().positive(),
        scheduled_at: z.string().datetime().optional().nullable(),
        notes: z.string().max(2000).optional().nullable(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    // Verify the order belongs to this workspace.
    const order = await db.query<{
      id: string;
      display_order_number: string | null;
      delivery_address: Record<string, unknown> | null;
    }>(
      `SELECT id, display_order_number, delivery_address
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2`,
      [orderId, wreq.workspaceOwnerId],
    );
    if (order.rowCount === 0) {
      fleetError(res, 404, "ORDER_NOT_FOUND", "Order not found");
      return;
    }
    // Verify driver belongs to workspace and is approved.
    const driver = await db.query<{ id: number; onboarding_status: string; expo_push_token: string | null }>(
      `SELECT id, onboarding_status, expo_push_token FROM fleet_drivers
        WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
      [parsed.data.driver_id, wreq.workspaceOwnerId],
    );
    if (driver.rowCount === 0) {
      fleetError(res, 404, "DRIVER_NOT_FOUND", "Driver not found");
      return;
    }
    if (driver.rows[0].onboarding_status !== "approved") {
      fleetError(res, 400, "DRIVER_NOT_APPROVED", "Driver is not approved");
      return;
    }
    const orderRow = order.rows[0];
    const deliveryAddr = orderRow.delivery_address as {
      address?: string;
      address_1?: string;
      city?: string;
    } | null;
    // Street line may live under the canonical `address` key (external ingest,
    // dashboard editor) or legacy `address_1` (older dashboard-saved rows).
    const deliveryAddress = deliveryAddr
      ? [deliveryAddr.address || deliveryAddr.address_1, deliveryAddr.city]
          .filter(Boolean)
          .join(", ") || null
      : null;
    // Upsert assignment by order_id.
    const existing = await db.query<{ id: number; driver_id: number }>(
      `SELECT id, driver_id FROM fleet_driver_order_assignments
        WHERE workspace_owner_id = $1 AND order_id = $2`,
      [wreq.workspaceOwnerId, orderId],
    );
    let assignmentId: number;
    if (existing.rowCount && existing.rows[0]) {
      assignmentId = existing.rows[0].id;
      const displacedDriverId = existing.rows[0].driver_id;
      await db.query(
        `UPDATE fleet_driver_order_assignments
            SET driver_id = $1, scheduled_at = $2, notes = $3,
                status = 'assigned', updated_at = now()
          WHERE id = $4`,
        [parsed.data.driver_id, parsed.data.scheduled_at ?? null, parsed.data.notes ?? null, assignmentId],
      );
      // If the order is being reassigned to a different driver, notify the displaced driver.
      if (displacedDriverId !== parsed.data.driver_id) {
        const displaced = await db.query<{ expo_push_token: string | null }>(
          `SELECT expo_push_token FROM fleet_drivers WHERE id = $1`,
          [displacedDriverId],
        );
        const displacedToken = displaced.rows[0]?.expo_push_token ?? null;
        const reassignData = { order_id: orderId, assignment_id: assignmentId };
        insertDriverNotification(
          displacedDriverId,
          "Delivery reassigned",
          "A delivery has been reassigned away from you",
          reassignData,
        ).catch((err: unknown) => {
          req.log.warn({ err, driver_id: displacedDriverId }, "Failed to insert reassignment notification");
        });
        if (displacedToken) {
          sendExpoPushNotification(
            displacedToken,
            "Delivery reassigned",
            "A delivery has been reassigned away from you",
            reassignData,
          ).catch((err: unknown) => {
            req.log.warn(
              { err, driver_id: displacedDriverId, order_id: orderId },
              "Failed to send reassignment push notification to displaced driver",
            );
          });
        }
        // Instant in-app alert for the displaced driver via SSE.
        driverSseBroadcast(displacedDriverId);
      }
    } else {
      const inserted = await db.query<{ id: number }>(
        `INSERT INTO fleet_driver_order_assignments
           (workspace_owner_id, driver_id, order_id, order_reference,
            delivery_address, status, scheduled_at, notes)
         VALUES ($1, $2, $3, $4, $5, 'assigned', $6, $7)
         RETURNING id`,
        [
          wreq.workspaceOwnerId,
          parsed.data.driver_id,
          orderId,
          orderRow.display_order_number ?? orderId,
          deliveryAddress,
          parsed.data.scheduled_at ?? null,
          parsed.data.notes ?? null,
        ],
      );
      assignmentId = inserted.rows[0].id;
    }

    // Send push notification to driver and persist in notification history — fire-and-forget.
    const pushToken = driver.rows[0].expo_push_token;
    const assignData = { order_id: orderId, assignment_id: assignmentId };
    insertDriverNotification(
      parsed.data.driver_id,
      "New delivery assigned",
      "You have a new delivery",
      assignData,
    ).catch((err: unknown) => {
      req.log.warn({ err, driver_id: parsed.data.driver_id }, "Failed to insert assignment notification");
    });
    if (pushToken) {
      sendExpoPushNotification(
        pushToken,
        "New delivery assigned",
        "You have a new delivery",
        assignData,
      ).catch((err: unknown) => {
        req.log.warn({ err, driver_id: parsed.data.driver_id, order_id: orderId }, "Failed to send push notification to driver");
      });
    }

    // Instant in-app alert via SSE — notifies the driver's open web/app tab immediately.
    driverSseBroadcast(parsed.data.driver_id);

  res.json({ success: true, order_id: orderId, assignment_id: assignmentId, driver_id: parsed.data.driver_id });
};
router.patch("/fleet/orders/:id/assign-driver", assignDriverHandler);

// Remove the driver assignment from an order (owner-only). Idempotent: if the
// order has no assignment it still returns success. Notifies the displaced
// driver via in-app notification, push, and SSE.
const unassignDriverHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const wreq = workspace(req);
  if (!fleetOrderAccess(wreq, res)) return;
  const orderId = req.params.id; // UUID from orders.id
  if (!orderId || typeof orderId !== "string" || orderId.length < 4) {
    fleetError(res, 400, "INVALID_ID", "Invalid order id");
    return;
  }
  const existing = await db.query<{ id: number; driver_id: number }>(
    `SELECT id, driver_id FROM fleet_driver_order_assignments
      WHERE workspace_owner_id = $1 AND order_id = $2`,
    [wreq.workspaceOwnerId, orderId],
  );
  if (existing.rowCount === 0 || !existing.rows[0]) {
    res.json({ success: true, order_id: orderId, driver_id: null });
    return;
  }
  const displacedDriverId = existing.rows[0].driver_id;
  await db.query(`DELETE FROM fleet_driver_order_assignments WHERE id = $1`, [
    existing.rows[0].id,
  ]);

  const displaced = await db.query<{ expo_push_token: string | null }>(
    `SELECT expo_push_token FROM fleet_drivers WHERE id = $1`,
    [displacedDriverId],
  );
  const displacedToken = displaced.rows[0]?.expo_push_token ?? null;
  const data = { order_id: orderId };
  insertDriverNotification(
    displacedDriverId,
    "Delivery removed",
    "A delivery has been removed from you",
    data,
  ).catch((err: unknown) => {
    req.log.warn({ err, driver_id: displacedDriverId }, "Failed to insert unassignment notification");
  });
  if (displacedToken) {
    sendExpoPushNotification(
      displacedToken,
      "Delivery removed",
      "A delivery has been removed from you",
      data,
    ).catch((err: unknown) => {
      req.log.warn(
        { err, driver_id: displacedDriverId, order_id: orderId },
        "Failed to send unassignment push notification to displaced driver",
      );
    });
  }
  driverSseBroadcast(displacedDriverId);

  res.json({ success: true, order_id: orderId, driver_id: null });
};
router.delete("/fleet/orders/:id/assign-driver", unassignDriverHandler);
router.post("/fleet/orders/:id/assign-driver", assignDriverHandler);

// ---------------------------------------------------------------------------
// Admin: POST /fleet/orders/:id/proof-of-delivery — owner-side recording of
// proof for an order's assignment (mirrors the driver-side endpoint and
// satisfies the documented admin contract).
// ---------------------------------------------------------------------------
router.post(
  "/fleet/orders/:id/proof-of-delivery",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const orderId = req.params.id; // UUID from orders.id
    if (!orderId || typeof orderId !== "string" || orderId.length < 4) {
      fleetError(res, 400, "INVALID_ID", "Invalid order id");
      return;
    }
    const parsed = z
      .object({
        recipient_name: z.string().max(200).optional().nullable(),
        notes: z.string().max(2000).optional().nullable(),
        signature_data: z.string().max(200000).optional().nullable(),
        image_url: z.string().max(2000).optional().nullable(),
        latitude: z.number().min(-90).max(90).optional().nullable(),
        longitude: z.number().min(-180).max(180).optional().nullable(),
        mark_delivered: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const a = await db.query<{ id: number; driver_id: number; workspace_owner_id: string }>(
      `SELECT a.id, a.driver_id, a.workspace_owner_id FROM fleet_driver_order_assignments a
         JOIN orders o ON o.id = a.order_id
        WHERE a.order_id = $1 AND a.workspace_owner_id = $2`,
      [orderId, wreq.workspaceOwnerId],
    );
    if (a.rowCount === 0 || !a.rows[0]) {
      fleetError(res, 404, "ASSIGNMENT_NOT_FOUND", "No assignment found for that order");
      return;
    }
    const assignmentId = a.rows[0].id;
    const d = parsed.data;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO fleet_proof_of_delivery
         (workspace_owner_id, assignment_id, driver_id, recipient_name, notes,
          signature_data, has_signature, image_url, latitude, longitude, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING id`,
      [
        a.rows[0].workspace_owner_id,
        assignmentId,
        a.rows[0].driver_id,
        d.recipient_name ?? null,
        d.notes ?? null,
        d.signature_data ?? null,
        Boolean(d.signature_data),
        d.image_url ?? null,
        d.latitude ?? null,
        d.longitude ?? null,
      ],
    );
    if (d.mark_delivered !== false) {
      await db.query(
        `UPDATE fleet_driver_order_assignments
            SET status = 'delivered', delivered_at = now(), updated_at = now()
          WHERE id = $1`,
        [assignmentId],
      );
    }
    res.status(201).json({
      success: true,
      proof_id: inserted.rows[0].id,
      order_id: orderId,
      assignment_id: assignmentId,
    });
  },
);

// ---------------------------------------------------------------------------
// Admin: GET /fleet/orders/:id — full order detail with assignment and POD.
// ---------------------------------------------------------------------------
router.get(
  "/fleet/orders/:id",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const orderId = req.params.id; // UUID from orders.id
    if (!orderId || typeof orderId !== "string" || orderId.length < 4) {
      fleetError(res, 400, "INVALID_ID", "Invalid order id");
      return;
    }
    const order = await db.query(
      `SELECT o.id, o.display_order_number, o.status AS order_status,
              o.totals, o.delivery_address, o.ordered_at,
              c.display_name AS customer_name, c.email AS customer_email,
              a.id AS assignment_id, a.driver_id, a.status AS delivery_status,
              a.scheduled_at, a.accepted_at, a.picked_up_at, a.delivered_at, a.notes,
              d.first_name AS driver_first_name, d.last_name AS driver_last_name,
              d.phone AS driver_phone, d.country_code AS driver_country_code
         FROM orders o
    LEFT JOIN order_contacts ocon ON ocon.order_id = o.id AND ocon.role = 'customer'
    LEFT JOIN contacts c ON c.id = ocon.contact_id
    LEFT JOIN fleet_driver_order_assignments a ON a.order_id = o.id AND a.workspace_owner_id = $2
    LEFT JOIN fleet_drivers d ON d.id = a.driver_id
        WHERE o.id = $1 AND o.workspace_owner_id = $2`,
      [orderId, wreq.workspaceOwnerId],
    );
    if (order.rowCount === 0) {
      fleetError(res, 404, "ORDER_NOT_FOUND", "Order not found");
      return;
    }
    const orderRow = order.rows[0] as { assignment_id?: number };
    let events: unknown[] = [];
    let proof: unknown = null;
    if (orderRow.assignment_id) {
      const ev = await db.query(
        `SELECT id, event_type, notes, lat, lng, occurred_at
           FROM fleet_delivery_events
          WHERE assignment_id = $1
          ORDER BY occurred_at DESC`,
        [orderRow.assignment_id],
      );
      events = ev.rows;
      const pod = await db.query(
        `SELECT id, recipient_name, notes, has_signature, image_url,
                latitude, longitude, delivered_at, created_at
           FROM fleet_proof_of_delivery
          WHERE assignment_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [orderRow.assignment_id],
      );
      proof = pod.rows[0] ?? null;
    }
    res.json({ success: true, order: orderRow, events, proof_of_delivery: proof });
  },
);

// ---------------------------------------------------------------------------
// Admin: PATCH /fleet/orders/:id/status — owner-side override of an
// assignment's delivery status (e.g. cancellation).
// ---------------------------------------------------------------------------
router.patch(
  "/fleet/orders/:id/status",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!ownerOnly(wreq, res)) return;
    const orderId = req.params.id; // UUID from orders.id
    if (!orderId || typeof orderId !== "string" || orderId.length < 4) {
      fleetError(res, 400, "INVALID_ID", "Invalid order id");
      return;
    }
    const parsed = z
      .object({
        status: z.enum(DELIVERY_STATUSES),
        notes: z.string().max(2000).optional().nullable(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      fleetError(res, 400, "VALIDATION_ERROR", parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    const own = await db.query<{ id: number; driver_id: number }>(
      `SELECT a.id, a.driver_id FROM fleet_driver_order_assignments a
         JOIN orders o ON o.id = a.order_id
        WHERE a.order_id = $1 AND a.workspace_owner_id = $2`,
      [orderId, wreq.workspaceOwnerId],
    );
    if (own.rowCount === 0 || !own.rows[0]) {
      fleetError(res, 404, "ASSIGNMENT_NOT_FOUND", "No assignment found for that order");
      return;
    }
    const assignmentId = own.rows[0].id;
    const assignedDriverId = own.rows[0].driver_id;
    const stamps: string[] = [];
    if (parsed.data.status === "accepted") stamps.push(`accepted_at = COALESCE(accepted_at, now())`);
    if (parsed.data.status === "picked_up") stamps.push(`picked_up_at = COALESCE(picked_up_at, now())`);
    if (parsed.data.status === "delivered") stamps.push(`delivered_at = COALESCE(delivered_at, now())`);
    const stampSql = stamps.length > 0 ? `, ${stamps.join(", ")}` : "";
    await db.query(
      `UPDATE fleet_driver_order_assignments
          SET status = $1, notes = COALESCE($2, notes), updated_at = now()${stampSql}
        WHERE id = $3`,
      [parsed.data.status, parsed.data.notes ?? null, assignmentId],
    );
    await db.query(
      `INSERT INTO fleet_delivery_events (workspace_owner_id, assignment_id, event_type, notes)
       SELECT workspace_owner_id, $1, $2, $3 FROM fleet_driver_order_assignments WHERE id = $1`,
      [assignmentId, `admin_status_${parsed.data.status}`, parsed.data.notes ?? null],
    );
    // Notify the driver when their assignment is cancelled or returned.
    if (parsed.data.status === "cancelled" || parsed.data.status === "returned") {
      const driverRow = await db.query<{ expo_push_token: string | null }>(
        `SELECT expo_push_token FROM fleet_drivers WHERE id = $1`,
        [assignedDriverId],
      );
      const pushToken = driverRow.rows[0]?.expo_push_token ?? null;
      const cancelData = { order_id: orderId, assignment_id: assignmentId };
      insertDriverNotification(
        assignedDriverId,
        "Delivery cancelled",
        "Your assigned delivery has been cancelled",
        cancelData,
      ).catch((err: unknown) => {
        req.log.warn({ err, driver_id: assignedDriverId }, "Failed to insert cancellation notification");
      });
      if (pushToken) {
        sendExpoPushNotification(
          pushToken,
          "Delivery cancelled",
          "Your assigned delivery has been cancelled",
          cancelData,
        ).catch((err: unknown) => {
          req.log.warn(
            { err, driver_id: assignedDriverId, order_id: orderId },
            "Failed to send cancellation push notification to driver",
          );
        });
      }
    }
    driverSseBroadcastStatusChange(assignedDriverId);
    res.json({
      success: true,
      order_id: orderId,
      assignment_id: assignmentId,
      status: parsed.data.status,
    });
  },
);

export default router;
