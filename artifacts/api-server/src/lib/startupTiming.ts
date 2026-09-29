import { logger } from "./logger";

type TimingFields = Record<string, string | number | boolean | undefined>;

export function logStartupTiming(
  phase: string,
  event: "start" | "complete",
  startedAt?: number,
  fields: TimingFields = {},
): void {
  const timestamp = new Date().toISOString();
  const elapsedMs =
    startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
  const messageFields = [
    "[TIMING] component=api-server",
    `phase=${phase}`,
    `event=${event}`,
    `timestamp=${timestamp}`,
    elapsedMs === undefined ? undefined : `elapsed_ms=${elapsedMs}`,
    ...Object.entries(fields).map(([key, value]) =>
      value === undefined
        ? undefined
        : `${key}=${String(value).replace(/\s+/g, "_")}`,
    ),
  ].filter((value): value is string => value !== undefined);

  logger.info(
    {
      timing: {
        component: "api-server",
        phase,
        event,
        timestamp,
        elapsed_ms: elapsedMs,
        ...fields,
      },
    },
    messageFields.join(" "),
  );
}
