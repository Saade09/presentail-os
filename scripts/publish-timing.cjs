const { spawnSync } = require("node:child_process");

function logTiming(component, phase, event, startedAt, fields = {}) {
  const values = [
    `[TIMING] component=${component}`,
    `phase=${phase}`,
    `event=${event}`,
    `timestamp=${new Date().toISOString()}`,
  ];

  if (startedAt !== undefined) {
    values.push(`elapsed_ms=${Math.max(0, Date.now() - startedAt)}`);
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      values.push(`${key}=${String(value).replace(/\s+/g, "_")}`);
    }
  }

  console.log(values.join(" "));
}

function startTiming(component, phase) {
  const startedAt = Date.now();
  let finished = false;
  logTiming(component, phase, "start", startedAt);

  return {
    startedAt,
    complete(fields = {}) {
      if (finished) return;
      finished = true;
      logTiming(component, phase, "complete", startedAt, fields);
    },
  };
}

function runTimedCommand(component, phase, command, args, options = {}) {
  const timing = startTiming(component, phase);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  const failed = result.error || result.status !== 0;

  timing.complete({
    status: failed ? "failed" : "success",
    exit_code: result.status === null ? undefined : result.status,
    signal: result.signal,
  });

  if (result.error) {
    console.error(`[TIMING] command_error=${result.error.message}`);
  }

  return failed ? result.status || 1 : 0;
}

module.exports = { logTiming, startTiming, runTimedCommand };
