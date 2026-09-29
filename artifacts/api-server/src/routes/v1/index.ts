import { Router } from "express";
import { requireIngestAuth } from "../../lib/ingestAuth";
import contactsRouter from "./contacts";
import ordersRouter from "./orders";

const router = Router();

router.use("/v1", requireIngestAuth, contactsRouter, ordersRouter);

export default router;
