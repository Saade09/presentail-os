import { runCommandPhase } from "./phase.mjs";

const [, , phase, command, ...args] = process.argv;
if (!phase || !command) {
  throw new Error("Usage: node scripts/publish/run-phase.mjs <phase> <command> [args...]");
}
await runCommandPhase(phase, command, args);