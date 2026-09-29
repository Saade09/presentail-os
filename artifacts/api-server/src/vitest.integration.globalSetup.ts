import { initDb } from "./lib/initDb";
import { db } from "./lib/db";

const STALE_BACKUPS: { backup: string; original: string }[] = [
  { backup: "departments_absent_test_bak", original: "departments" },
  { backup: "departments_double_absent_bak", original: "departments" },
  { backup: "team_members_double_absent_bak", original: "team_members" },
];

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [name],
  );
  return rows[0]?.exists ?? false;
}

async function restoreStaleTables(): Promise<void> {
  for (const { backup, original } of STALE_BACKUPS) {
    const backupExists = await tableExists(backup);
    if (!backupExists) continue;

    const originalExists = await tableExists(original);
    if (originalExists) {
      // Both tables present — original is the live one; drop the stale backup.
      await db.query(`DROP TABLE ${backup}`);
    } else {
      await db.query(`ALTER TABLE ${backup} RENAME TO ${original}`);
    }
  }
}

export async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    return;
  }
  // Restore any stale backup tables BEFORE initDb recreates them.
  await restoreStaleTables();
  await initDb();
  await db.end();
}
