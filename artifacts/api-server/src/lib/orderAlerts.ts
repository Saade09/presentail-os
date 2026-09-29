import { db } from "./db";
import { logger } from "./logger";
import { sendWebPushToWorkspace } from "./webPush";
import { sendExpoPushNotification } from "./expoPush";

/**
 * New-order alert fan-out. Fire-and-forget: called (void) right after an
 * order.created SSE broadcast from every order-creation path
 * (manual wizard, external ingest, Toters import).
 *
 * Sends:
 *  - Web Push (VAPID) to every browser subscription in the workspace.
 *  - Expo push to every workspace team member with a registered device
 *    (team_members.expo_push_token — same store as attendance pushes).
 */
export async function notifyNewOrderAlerts(
  workspaceOwnerId: string,
  orderId: string,
): Promise<void> {
  try {
    const orderResult = await db.query<{
      display_order_number: string | null;
      customer_name: string | null;
      total: string | null;
      currency: string | null;
    }>(
      `SELECT o.display_order_number,
              NULLIF(TRIM(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))), '') AS customer_name,
              COALESCE(o.totals->>'paid_total', o.totals->>'total') AS total,
              COALESCE(o.totals->>'paid_currency', o.totals->>'currency') AS currency
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 AND o.workspace_owner_id = $2
        LIMIT 1`,
      [orderId, workspaceOwnerId],
    );
    if (orderResult.rows.length === 0) return;
    const order = orderResult.rows[0];

    const orderLabel = order.display_order_number
      ? `#${order.display_order_number}`
      : `#${orderId.slice(0, 8)}`;
    const parts: string[] = [];
    if (order.customer_name) parts.push(order.customer_name);
    if (order.total) {
      const amount = Number(order.total);
      if (Number.isFinite(amount) && amount > 0) {
        parts.push(`${order.currency ?? "USD"} ${amount.toFixed(2)}`);
      }
    }
    const title = `New order ${orderLabel}`;
    const body = parts.length > 0 ? parts.join(" — ") : "A new order was received";

    // Web push (best-effort)
    try {
      await sendWebPushToWorkspace(workspaceOwnerId, {
        title,
        body,
        url: `/orders/${orderId}`,
        tag: `new-order-${orderId}`,
      });
    } catch (err: unknown) {
      logger.warn({ err, orderId }, "New-order web push fan-out failed");
    }

    // Expo push to workspace team members with registered devices
    try {
      const tokensResult = await db.query<{ expo_push_token: string }>(
        `SELECT DISTINCT expo_push_token
           FROM team_members
          WHERE workspace_owner_id = $1
            AND expo_push_token IS NOT NULL
            AND archived_at IS NULL`,
        [workspaceOwnerId],
      );
      for (const row of tokensResult.rows) {
        await sendExpoPushNotification(
          row.expo_push_token,
          title,
          body,
          { screen: "orders", orderId },
          async (staleToken: string) => {
            await db.query(
              `UPDATE team_members SET expo_push_token = NULL, updated_at = now()
                WHERE expo_push_token = $1`,
              [staleToken],
            );
          },
        );
      }
    } catch (err: unknown) {
      logger.warn({ err, orderId }, "New-order Expo push fan-out failed");
    }
  } catch (err: unknown) {
    logger.warn({ err, orderId }, "New-order alert fan-out failed");
  }
}

/**
 * Florist-assignment alert fan-out. Fire-and-forget: called (void) right after
 * the `order.assigned_to_florist` SSE broadcast when an order is sent to a
 * florist location.
 *
 * Sends an Expo push ONLY to team members whose workspace_members row is tied
 * to the assigned florist location (workspace_members.florist_location_id) and
 * who have a registered device — never the whole workspace.
 */
export async function notifyFloristAssignmentAlerts(
  workspaceOwnerId: string,
  orderId: string,
  locationId: number,
): Promise<void> {
  try {
    const orderResult = await db.query<{
      display_order_number: string | null;
      location_name: string | null;
    }>(
      `SELECT o.display_order_number, l.name AS location_name
         FROM orders o
         LEFT JOIN locations l ON l.id = $3 AND l.workspace_owner_id = $2
        WHERE o.id = $1 AND o.workspace_owner_id = $2
        LIMIT 1`,
      [orderId, workspaceOwnerId, locationId],
    );
    if (orderResult.rows.length === 0) return;
    const order = orderResult.rows[0];

    const orderLabel = order.display_order_number
      ? `#${order.display_order_number}`
      : `#${orderId.slice(0, 8)}`;
    const title = `Order ${orderLabel} assigned to you`;
    const body = order.location_name
      ? `New order to prepare at ${order.location_name}`
      : "A new order was assigned to your florist station";

    const tokensResult = await db.query<{ expo_push_token: string }>(
      `SELECT DISTINCT tm.expo_push_token
         FROM team_members tm
         JOIN workspace_members wm
           ON wm.id = tm.member_db_id
          AND wm.workspace_owner_id = tm.workspace_owner_id
        WHERE tm.workspace_owner_id = $1
          AND tm.expo_push_token IS NOT NULL
          AND tm.archived_at IS NULL
          AND wm.florist_location_id = $2`,
      [workspaceOwnerId, locationId],
    );
    for (const row of tokensResult.rows) {
      await sendExpoPushNotification(
        row.expo_push_token,
        title,
        body,
        { screen: "florist-orders", orderId },
        async (staleToken: string) => {
          await db.query(
            `UPDATE team_members SET expo_push_token = NULL, updated_at = now()
              WHERE expo_push_token = $1`,
            [staleToken],
          );
        },
      );
    }
  } catch (err: unknown) {
    logger.warn(
      { err, orderId, locationId },
      "Florist-assignment alert fan-out failed",
    );
  }
}

/**
 * Cash-session alert fan-out — shared helper.
 * Sends an Expo push to every workspace owner and every team member whose
 * custom role has `cash_sessions.approve` in `allowed_pages`.
 */
async function notifyCashSessionAlerts(
  workspaceOwnerId: string,
  sessionId: number,
  title: string,
  body: string,
): Promise<void> {
  const tokensResult = await db.query<{ expo_push_token: string }>(
    `SELECT DISTINCT tm.expo_push_token
       FROM team_members tm
       JOIN workspace_members wm
         ON wm.id = tm.member_db_id
        AND wm.workspace_owner_id = tm.workspace_owner_id
       LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
      WHERE tm.workspace_owner_id = $1
        AND tm.expo_push_token IS NOT NULL
        AND tm.archived_at IS NULL
        AND (wm.role = 'owner'
             OR wr.allowed_pages @> '["cash_sessions.approve"]'::jsonb)`,
    [workspaceOwnerId],
  );

  for (const row of tokensResult.rows) {
    await sendExpoPushNotification(
      row.expo_push_token,
      title,
      body,
      { screen: "cash-sessions", sessionId },
      async (staleToken: string) => {
        await db.query(
          `UPDATE team_members SET expo_push_token = NULL, updated_at = now()
            WHERE expo_push_token = $1`,
          [staleToken],
        );
      },
    );
  }
}

/**
 * Notifies managers when a cash session is flagged.
 * Fire-and-forget; called right after the `cash_session.flagged` SSE broadcast.
 */
export async function notifyCashSessionFlaggedAlerts(
  workspaceOwnerId: string,
  sessionId: number,
  sessionNumber: string,
  drawerName: string | null,
): Promise<void> {
  try {
    const label = drawerName ? `${sessionNumber} (${drawerName})` : sessionNumber;
    const title = `Cash session flagged`;
    const body = `Session ${label} has been flagged and needs review.`;
    await notifyCashSessionAlerts(workspaceOwnerId, sessionId, title, body);
  } catch (err: unknown) {
    logger.warn({ err, sessionId }, "Cash-session flagged alert fan-out failed");
  }
}

/**
 * Notifies managers when a cash session has been open longer than the
 * configured threshold (8 hours). Fire-and-forget.
 */
export async function notifyCashSessionLongOpenAlerts(
  workspaceOwnerId: string,
  sessionId: number,
  sessionNumber: string,
  drawerName: string | null,
): Promise<void> {
  try {
    const label = drawerName ? `${sessionNumber} (${drawerName})` : sessionNumber;
    const title = `Cash session open too long`;
    const body = `Session ${label} has been open for over 8 hours.`;
    await notifyCashSessionAlerts(workspaceOwnerId, sessionId, title, body);
  } catch (err: unknown) {
    logger.warn({ err, sessionId }, "Cash-session long-open alert fan-out failed");
  }
}

/**
 * Sends an Expo push to a single team member by their token. Used to notify
 * the session opener for Stage 1 (closing_time) and Stage 2 (overdue) alerts.
 * No-op when openerToken is null.
 */
async function notifySessionOpener(
  sessionId: number,
  openerToken: string | null,
  title: string,
  body: string,
): Promise<void> {
  if (!openerToken) return;
  await sendExpoPushNotification(
    openerToken,
    title,
    body,
    { screen: "cash-sessions", sessionId },
    async (staleToken: string) => {
      await db.query(
        `UPDATE team_members SET expo_push_token = NULL, updated_at = now()
          WHERE expo_push_token = $1`,
        [staleToken],
      );
    },
  );
}

/**
 * Stage 1 – closing-time reminder.
 * Notifies the session opener when the cutoff time has passed but the grace
 * period has not yet expired. Fire-and-forget.
 */
export async function notifyCashSessionClosingTimeAlert(
  workspaceOwnerId: string,
  sessionId: number,
  sessionNumber: string,
  drawerName: string | null,
  openerToken: string | null,
): Promise<void> {
  try {
    const label = drawerName ? `${sessionNumber} (${drawerName})` : sessionNumber;
    await notifySessionOpener(
      sessionId,
      openerToken,
      `Cash session needs to be closed`,
      `Your cash session ${label} needs to be closed.`,
    );
  } catch (err: unknown) {
    logger.warn({ err, sessionId }, "Cash-session closing-time alert failed");
  }
}

/**
 * Stage 2 – overdue alert.
 * Notifies the session opener when the grace period has fully expired.
 * Fire-and-forget. (Manager escalation is handled separately in Stage 3.)
 */
export async function notifyCashSessionOverdueAlerts(
  workspaceOwnerId: string,
  sessionId: number,
  sessionNumber: string,
  drawerName: string | null,
  openerToken: string | null,
): Promise<void> {
  try {
    const label = drawerName ? `${sessionNumber} (${drawerName})` : sessionNumber;
    await notifySessionOpener(
      sessionId,
      openerToken,
      `Cash session overdue`,
      `Session ${label} is now overdue – grace period has passed.`,
    );
  } catch (err: unknown) {
    logger.warn({ err, sessionId }, "Cash-session overdue alert fan-out failed");
  }
}

/**
 * Stage 3 – manager escalation.
 * Fans out to workspace owners and members with cash_sessions.approve
 * permission, 60 minutes after the grace period expired. Fire-and-forget.
 */
export async function notifyCashSessionManagerEscalationAlerts(
  workspaceOwnerId: string,
  sessionId: number,
  sessionNumber: string,
  drawerName: string | null,
): Promise<void> {
  try {
    const label = drawerName ? `${sessionNumber} (${drawerName})` : sessionNumber;
    await notifyCashSessionAlerts(
      workspaceOwnerId,
      sessionId,
      `Manager action required`,
      `Session ${label} is overdue for over 1 hour past grace.`,
    );
  } catch (err: unknown) {
    logger.warn({ err, sessionId }, "Cash-session manager escalation alert fan-out failed");
  }
}
