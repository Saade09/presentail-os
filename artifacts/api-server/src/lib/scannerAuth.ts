import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { db } from "./db.js";

export type ScannerDeviceRequest = Request & {
  scannerStationId: number;
  scannerWorkspaceOwnerId: string;
  scannerEntityId: number | null;
  scannerEntityActive: boolean;
  scannerPairingCorrelationId: string | null;
  scannerStationName: string;
  scannerEntityName: string | null;
  scannerLocation: string | null;
};

/** Narrow a Request to ScannerDeviceRequest after `requireScannerDevice` has run. */
export function scannerDevice(req: Request): ScannerDeviceRequest {
  return req as unknown as ScannerDeviceRequest;
}

/**
 * Express middleware that authenticates scanner device requests via a
 * hashed bearer token stored in scanner_device_tokens.
 *
 * Reads the Authorization: Bearer <token> header, hashes it with SHA-256,
 * and verifies it against the DB — joining scanner_stations to confirm the
 * station is active. Attaches station context to the request on success.
 * Entity validity is attached as context so device endpoints can return a
 * useful configuration response without repeating the station lookup.
 */
export async function requireScannerDevice(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Scanner device token required" });
    return;
  }
  const rawToken = authHeader.slice(7).trim();
  if (!rawToken) {
    res.status(401).json({ error: "Scanner device token required" });
    return;
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const result = await db.query<{
    station_id: number;
    workspace_owner_id: string;
    entity_id: number | null;
    status: string;
    entity_active: boolean;
    pairing_correlation_id: string | null;
    station_name: string;
    entity_name: string | null;
    location: string | null;
  }>(
    `SELECT sdt.station_id, sdt.workspace_owner_id, ss.entity_id, ss.status,
            sdt.pairing_correlation_id,
            ss.name AS station_name,
            COALESCE(fe.display_name, fe.legal_name) AS entity_name,
            ss.location,
            (fe.id IS NOT NULL) AS entity_active
       FROM scanner_device_tokens sdt
       JOIN scanner_stations ss ON ss.id = sdt.station_id
       LEFT JOIN finance_entities fe
         ON fe.id = ss.entity_id
        AND fe.workspace_owner_id = ss.workspace_owner_id
        AND fe.is_active = true
      WHERE sdt.token_hash = $1
        AND sdt.workspace_owner_id = ss.workspace_owner_id`,
    [tokenHash],
  );

  if (result.rowCount === 0) {
    res.status(401).json({
      error: "Invalid or revoked scanner token",
      code: "SCANNER_TOKEN_REVOKED",
    });
    return;
  }

  const row = result.rows[0];
  if (row.status !== "active") {
    res.status(403).json({
      error: "Scanner station is disabled",
      code: "SCANNER_STATION_DISABLED",
    });
    return;
  }

  const sreq = req as ScannerDeviceRequest;
  sreq.scannerStationId = row.station_id;
  sreq.scannerWorkspaceOwnerId = row.workspace_owner_id;
  sreq.scannerEntityId = row.entity_id;
  sreq.scannerEntityActive = row.entity_active;
  sreq.scannerPairingCorrelationId = row.pairing_correlation_id;
  sreq.scannerStationName = row.station_name;
  sreq.scannerEntityName = row.entity_name;
  sreq.scannerLocation = row.location;
  next();
}
