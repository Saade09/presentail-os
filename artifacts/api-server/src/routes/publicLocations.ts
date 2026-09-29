import { Router, type Request, type Response } from "express";

const router = Router();

/**
 * GET /api/public/locations — removed (410 Gone).
 * Use GET /api/delivery-locations instead.
 */
router.get("/public/locations", (_req: Request, res: Response) => {
  res.set("Link", '</api/delivery-locations>; rel="successor-version"');
  res.status(410).json({
    error: "This endpoint has been removed. Use GET /api/delivery-locations instead.",
    successor: "/api/delivery-locations",
  });
});

/**
 * GET /api/public/products/:productId/availability — removed (410 Gone).
 */
router.get("/public/products/:productId/availability", (_req: Request, res: Response) => {
  res.status(410).json({
    error: "This endpoint has been removed. Per-product city availability is no longer tracked.",
  });
});

export default router;
