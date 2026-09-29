import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { upsertContact } from "../../lib/contactUpsert";

const router = Router();

const contactBodySchema = z.object({
  workspace_owner_id: z.string().min(1),
  source: z.string().optional().nullable(),
  external_contact_id: z.string().optional().nullable(),
  account_id: z.string().optional().nullable(),
  is_guest: z.boolean().optional(),
  first_name: z.string().optional().nullable(),
  last_name: z.string().optional().nullable(),
  display_name: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  addresses: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

router.post("/contacts/upsert", async (req: Request, res: Response): Promise<void> => {
  const parsed = contactBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;
  const id = await upsertContact({
    workspaceOwnerId: d.workspace_owner_id,
    source: d.source,
    externalContactId: d.external_contact_id,
    accountId: d.account_id,
    isGuest: d.is_guest,
    firstName: d.first_name,
    lastName: d.last_name,
    displayName: d.display_name,
    email: d.email,
    phone: d.phone,
    tags: d.tags,
  });
  if (!id) {
    res.status(422).json({ error: "At least one identifier (source+external_contact_id, account_id, email, or phone) is required" });
    return;
  }

  res.status(200).json({ success: true, id });
});

export default router;
