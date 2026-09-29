import { readFile } from "node:fs/promises";

const expected = ["@workspace/api-server", "@workspace/print-agent-web"];
const contract = JSON.parse(
  await readFile(
    new URL("./production-services.json", import.meta.url),
    "utf8",
  ),
);
const actual = contract.services.map((service) => service.package);

if (actual.join(",") !== expected.join(",")) {
  throw new Error(
    `Production service contract changed (${actual.join(", ")}); update every artifact production build explicitly.`,
  );
}

console.log(
  JSON.stringify({
    schema: "presentail.publish.v1",
    event: "publish.contract",
    timestamp: new Date().toISOString(),
    status: "passed",
    domain: contract.domain,
    services: actual,
  }),
);