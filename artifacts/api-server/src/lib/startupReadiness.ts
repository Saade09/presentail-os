import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger";

let databaseReady = process.env.NODE_ENV === "test";

export function markDatabaseReady(): void {
  databaseReady = true;
}

export function markDatabaseStarting(): void {
  databaseReady = false;
}

export function startupReadinessGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isLivenessProbe =
    (req.method === "GET" || req.method === "HEAD") &&
    (req.path === "/api/healthz" || req.path === "/api" || req.path === "/api/");

  if (
    databaseReady ||
    isLivenessProbe ||
    req.method === "OPTIONS" ||
    !req.path.startsWith("/api")
  ) {
    next();
    return;
  }

  logger.warn(
    { method: req.method, url: req.path },
    "Request held outside application while database startup is incomplete",
  );
  res.setHeader("Retry-After", "5");
  res.setHeader("X-Presentail-Startup", "pending");
  res.status(503).json({
    error: "System update in progress. Please retry in a moment.",
    code: "startup_in_progress",
  });
}