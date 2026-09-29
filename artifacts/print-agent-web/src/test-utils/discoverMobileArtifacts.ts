/**
 * Shared test utility: discovers Expo (mobile) artifact directories by
 * inspecting each sub-directory of `artifacts/` for a
 * `.replit-artifact/artifact.toml` file that declares `kind = "mobile"`.
 *
 * A new mobile artifact is picked up automatically on the next test run —
 * no manual list update is needed.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const WORKSPACE_ROOT = resolve(__dirname, "../../../..");
const ARTIFACTS_ROOT = join(WORKSPACE_ROOT, "artifacts");

export function discoverMobileArtifactDirs(): string[] {
  if (!existsSync(ARTIFACTS_ROOT)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(ARTIFACTS_ROOT, entry.name);
    const tomlPath = join(dir, ".replit-artifact", "artifact.toml");
    if (!existsSync(tomlPath)) continue;
    const toml = readFileSync(tomlPath, "utf-8");
    if (/^\s*kind\s*=\s*"mobile"/m.test(toml)) {
      dirs.push(dir);
    }
  }
  return dirs;
}
