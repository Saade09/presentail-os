import type { Request, Response } from "express";
import type { z } from "zod";

export function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error(
      { err: parsed.error.issues, route },
      "Response validation failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}
