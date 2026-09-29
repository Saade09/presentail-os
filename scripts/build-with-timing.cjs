const { runTimedCommand, startTiming } = require("./publish-timing.cjs");

function exitWithStatus(status) {
  if (status !== 0) process.exit(status);
}

function runWorkspaceBuild() {
  const overall = startTiming("workspace", "build");
  const typecheckStatus = runTimedCommand("workspace", "typecheck", "pnpm", [
    "run",
    "typecheck",
  ]);
  if (typecheckStatus !== 0) {
    overall.complete({ status: "failed" });
    return typecheckStatus;
  }

  const buildStatus = runTimedCommand("workspace", "recursive_build", "pnpm", [
    "-r",
    "--if-present",
    "run",
    "build",
  ]);
  overall.complete({ status: buildStatus === 0 ? "success" : "failed" });
  return buildStatus;
}

const [component, ...command] = process.argv.slice(2);
if (!component) {
  console.error(
    "Usage: node scripts/build-with-timing.cjs <component> [command args...]",
  );
  process.exit(2);
}

const status =
  component === "root"
    ? runWorkspaceBuild()
    : command.length > 0
      ? runTimedCommand(component, "build", command[0], command.slice(1))
      : 2;

if (status === 2) {
  console.error("A build command is required for non-root components.");
}
exitWithStatus(status);
