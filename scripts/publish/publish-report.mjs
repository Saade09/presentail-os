import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { EVENTS_FILE, REPORT_DIR } from "./phase.mjs";
import { collectInventory } from "./context-inventory.mjs";
import { directoryBytes } from "./phase.mjs";
import {
  correlationId,
  projectLocalEvent,
  readTranscript,
  withCorrelation,
} from "./transcript.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

if (process.argv.includes("--help")) {
  console.log(`Usage: pnpm publish:report -- [options]

Generate a local publish report. To include the complete Publishing UI transcript:
  --transcript <path>     exported/copied Publishing tool transcript
  --publish-id <id>       ID that correlates every imported phase to one publish
  --transcript-output <path>
                          optional standalone sanitized transcript destination
  --output <path>         report destination (or PUBLISH_REPORT_OUTPUT)
`);
  process.exit(0);
}

const transcriptPath = option("--transcript") || process.env.PUBLISH_TRANSCRIPT_FILE;
const requestedPublishId = option("--publish-id") || process.env.PUBLISH_ID || null;
const transcript = transcriptPath
  ? withCorrelation(await readTranscript(transcriptPath), requestedPublishId)
  : null;

const allEvents = existsSync(EVENTS_FILE)
  ? (await readFile(EVENTS_FILE, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const reportPublishId =
  transcript?.publishId || correlationId(requestedPublishId);
const events = reportPublishId
  ? allEvents.filter(
      (event) => correlationId(event.publishId) === reportPublishId,
    )
  : allEvents;
const projectedEvents = events.map(projectLocalEvent).filter(Boolean);
const inventory = await collectInventory();
const phases = [
  "upload",
  "install",
  "typecheck:production",
  "build:api-server",
  "build:print-agent-web",
  "chromium-preparation",
  "package:api-runtime",
  "image-push",
  "startup",
  "health-check",
];
const report = {
  schema: "presentail.publish.report.v1",
  generatedAt: new Date().toISOString(),
  reportDir: REPORT_DIR,
  publishId: reportPublishId,
  excludedLocalEventCount: allEvents.length - events.length,
  phases: Object.fromEntries(
    phases.map((phase) => [
      phase,
      projectedEvents.filter((event) => event.phase === phase),
    ]),
  ),
  publishingTranscript: transcript,
  deploymentContext: inventory,
  measurements: {
    apiOutputBytes: directoryBytes("artifacts/api-server/dist"),
    apiRuntimeDependencyBytes: directoryBytes("artifacts/api-server/dist/node_modules"),
    webBundleBytes: directoryBytes("artifacts/print-agent-web/dist/public"),
    chromiumBytes: directoryBytes(".cache/ms-playwright/chromium-1217"),
    localExcludedChromiumHeadlessShellBytes: directoryBytes(
      ".cache/ms-playwright/chromium_headless_shell-1217",
    ),
    deploymentImageBytes: null,
    imagePushMs: null,
    uploadMs: null,
  },
  notes: [
    transcript
      ? "Publishing-tool timings were imported from the sanitized Publishing UI export and correlated by publishId."
      : "Pass --transcript and --publish-id to retain the complete Publishing-tool transcript; local runtime events alone cannot provide platform timings.",
    reportPublishId
      ? "Local phase events without this report's publishId are excluded to prevent cross-publish evidence."
      : "Set PUBLISH_ID while building to correlate local phase events to a Publishing transcript.",
    "Install downloaded bytes are null because pnpm lifecycle hooks expose store state, not network transfer counters.",
    "Retain the report and its sanitized transcript evidence alongside each publish for before/after comparison.",
  ],
};
const outputPath =
  option("--output") ||
  process.env.PUBLISH_REPORT_OUTPUT ||
  path.join(REPORT_DIR, "publish-report.json");
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
let transcriptOutputPath = null;
if (transcript) {
  transcriptOutputPath =
    option("--transcript-output") ||
    process.env.PUBLISH_TRANSCRIPT_OUTPUT ||
    path.join(path.dirname(outputPath), "publishing-transcript.json");
  await mkdir(path.dirname(path.resolve(transcriptOutputPath)), {
    recursive: true,
  });
  await writeFile(
    transcriptOutputPath,
    `${JSON.stringify(transcript, null, 2)}\n`,
  );
}
console.log(
  JSON.stringify({
    schema: report.schema,
    outputPath,
    phaseCount: projectedEvents.length,
    publishId: report.publishId,
    transcriptOutputPath,
    transcriptRecordCount: transcript?.recordCount || 0,
  }),
);