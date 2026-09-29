#!/usr/bin/env node
/**
 * Run this in the OLD Replit project's Shell:
 *
 *   curl -s "https://5774b37b-8a67-4647-b631-83d7afe42220-00-1fdq68bgugv1c.pike.replit.dev/api/migrate-image-script?token=prod-seed-2026-presentail" -o /tmp/migrate-images.mjs && node /tmp/migrate-images.mjs
 *
 * No extra packages needed — uses only Node.js built-ins + the Replit GCS sidecar.
 */

// ── Config ──────────────────────────────────────────────────────────────────
const NEW_DEV_URL   = "https://5774b37b-8a67-4647-b631-83d7afe42220-00-1fdq68bgugv1c.pike.replit.dev";
const MIGRATION_TOKEN = "prod-seed-2026-presentail";
const SIDECAR       = "http://127.0.0.1:1106";

// PRIVATE_OBJECT_DIR is set automatically by Replit in the old project's env.
// e.g. /replit-objstore-OLDUUID/.private
const PRIVATE_OBJECT_DIR = process.env.PRIVATE_OBJECT_DIR;
if (!PRIVATE_OBJECT_DIR) {
  console.error("ERROR: PRIVATE_OBJECT_DIR env var is not set. Are you running this in the OLD Replit project?");
  process.exit(1);
}

// Derive bucket name and dir prefix from PRIVATE_OBJECT_DIR
// e.g. /replit-objstore-abc/.private → bucket=replit-objstore-abc, dirPrefix=.private
const dirParts  = PRIVATE_OBJECT_DIR.replace(/^\//, "").split("/");
const OLD_BUCKET = dirParts[0];
const DIR_PREFIX = dirParts.slice(1).join("/");   // usually ".private"

console.log(`Old bucket: ${OLD_BUCKET}`);
console.log(`Dir prefix: ${DIR_PREFIX}`);

// ── Image list (pre-queried from old DB — no pg needed) ─────────────────────
// kind, id, image_path in old project storage
const IMAGES = [
  { kind: "base_item", id: 1,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/96e0e7c1-c09e-43c3-ba66-b64aa0103353" },
  { kind: "base_item", id: 2,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/7c72133a-293f-4dc1-a4a0-1df1010b1eb9" },
  { kind: "base_item", id: 3,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/d72a1cce-3301-4bd2-875f-e7fc82152ff7" },
  { kind: "base_item", id: 4,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/300772e9-9bbb-4ab7-991e-6d8624594481" },
  { kind: "base_item", id: 5,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/3e4c447d-f33f-4efc-badc-ba7bac178503" },
  { kind: "base_item", id: 6,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/8fa2a180-44d4-4123-aa28-4b0b066c00c3" },
  { kind: "base_item", id: 7,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/858a5464-3b6e-45c8-86d1-af39cdfd76ee" },
  { kind: "base_item", id: 8,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/619dc4e2-933b-4865-9f2f-b4f6e858cc0a" },
  { kind: "base_item", id: 9,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/d085787c-e7a8-4d3a-9236-e4703c66136d" },
  { kind: "base_item", id: 10,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/a719b677-d286-4678-8226-7f7581eab52f" },
  { kind: "base_item", id: 11,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/c9eac90d-697d-40d5-b67b-c3adcb2429cc" },
  { kind: "base_item", id: 12,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/95156562-59e7-434a-8b6a-ce4d35b72778" },
  { kind: "base_item", id: 13,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/base-items/e4d57e28-2faf-400a-83ea-b7fd7071a342" },
  { kind: "product",   id: 2,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/7bde2433-ded4-44bc-86bb-db893da09109" },
  { kind: "product",   id: 3,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/bde9566d-dff0-48b6-835c-e728104f3199" },
  { kind: "product",   id: 4,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/865e5f1d-0364-4eb3-ab83-031b3e2a6e38" },
  { kind: "product",   id: 5,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/976e805d-db11-4d1e-b66f-608e3498f2ea" },
  { kind: "product",   id: 6,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/99c8e146-46b5-4be8-941f-4a9b6cdee3a0" },
  { kind: "product",   id: 7,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/cb93843e-a654-4c43-a9b1-fc517ea58123" },
  { kind: "product",   id: 8,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/73da3d30-0928-4bb7-9868-af718ece19b4" },
  { kind: "product",   id: 9,   path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/f8d9ac10-e091-4f99-8bce-c0a9d4f9fd76" },
  { kind: "product",   id: 10,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/20e7c6a8-b201-47ef-a799-6ca3c9310460" },
  { kind: "product",   id: 11,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/81300a38-421b-40a2-9d64-33508178be65" },
  { kind: "product",   id: 12,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/1713b43d-2c95-4e0e-a9f3-7c254bbc3118" },
  { kind: "product",   id: 13,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/e2c422c4-ea37-4b80-8016-1e1985cc2d6f" },
  { kind: "product",   id: 14,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/3f895d40-6389-453f-887c-31f71dbbee12" },
  { kind: "product",   id: 15,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/2585bdde-ebd8-49b6-b8be-7c3d178ec05c" },
  { kind: "product",   id: 16,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/1b69c156-5418-4d30-a771-3d9d0d3efb5f" },
  { kind: "product",   id: 17,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/43d4de2c-78c3-4ccf-9bd5-3e8ad74dca01" },
  { kind: "product",   id: 18,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/2ed7912f-2cd5-4796-ad79-dc4c5b380180" },
  { kind: "product",   id: 19,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/abf541f7-35c5-4082-942f-4524d72f65fa" },
  { kind: "product",   id: 20,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/d15a084d-a031-4806-a09b-22b7151ff9db" },
  { kind: "product",   id: 21,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/0910ca03-2942-4e51-a728-1b50e740c160" },
  { kind: "product",   id: 22,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/a6c6a652-89b1-47b3-a604-b66cf3f7be55" },
  { kind: "product",   id: 23,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/fbbe3a10-92bb-4892-a82d-cb26c3b7bc56" },
  { kind: "product",   id: 24,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/e83e2c57-4a5a-4a4c-a89b-74d59078ada5" },
  { kind: "product",   id: 25,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/5bfad220-a3fe-4d95-904f-b2385a569f64" },
  { kind: "product",   id: 26,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/46c5d691-e482-431c-93a0-615e72141d3a" },
  { kind: "product",   id: 27,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/7ea62619-1674-4010-a4a3-070470a1c5ae" },
  { kind: "product",   id: 28,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/3fe0f3ff-ae38-4bec-bfb9-e5f5ebd73dfd" },
  { kind: "product",   id: 29,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/1751737f-a190-4daf-991a-53fff45b2ee9" },
  { kind: "product",   id: 30,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/a0343f6a-cc87-4e92-8e6a-aa8265f654a7" },
  { kind: "product",   id: 31,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/b4f94c3e-8ef5-4d91-ab16-36bd36141450" },
  { kind: "product",   id: 32,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/03bae095-374b-465c-8907-188b9b4a1d15" },
  { kind: "product",   id: 33,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/100d4bee-6d65-4f02-a3d9-4332932745c7" },
  { kind: "product",   id: 34,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/8902e421-ba2d-420b-9ab3-ae2d86342172" },
  { kind: "product",   id: 35,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/09b37d76-e4f6-458b-8997-ed77423f794b" },
  { kind: "product",   id: 36,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/e4ab9c45-1fb9-428d-90ac-fc1ac45994cb" },
  { kind: "product",   id: 37,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/d73430ca-4eda-414c-9f6e-2ea105783506" },
  { kind: "product",   id: 38,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/86093970-4c64-4380-904d-5dbece633ff8" },
  { kind: "product",   id: 39,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/fdcdadda-cbb7-4d52-ad8a-a2bae0d23077" },
  { kind: "product",   id: 40,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/d59f11f3-02c1-4b4e-843c-4bed2e479a2c" },
  { kind: "product",   id: 41,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/69b92dfb-3052-4231-9868-6d6a190df670" },
  { kind: "product",   id: 42,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/a4728988-4185-4f97-af07-1cccbd7e4eee" },
  { kind: "product",   id: 43,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/70a2d537-1f01-4b15-a8fe-89322ce08732" },
  { kind: "product",   id: 44,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/9c602ded-811f-45ab-a8ab-c36a7f025481" },
  { kind: "product",   id: 45,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/844b6e04-480c-4b9d-b192-4dc87181c462" },
  { kind: "product",   id: 46,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/7d146162-c1f4-40da-a709-fb25e19aaf14" },
  { kind: "product",   id: 47,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/b77f887a-e6b2-4e58-8a22-8bc670c6d3e7" },
  { kind: "product",   id: 48,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/f3668c4e-b0f7-4879-9467-353a8e79979e" },
  { kind: "product",   id: 49,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/4a138a77-1975-4643-8c66-488e92d4b6de" },
  { kind: "product",   id: 50,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/beb24eae-7864-4250-95db-85467dcb5ac9" },
  { kind: "product",   id: 51,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/062d20c0-2a01-44a5-ab9b-4f23b8e7c00d" },
  { kind: "product",   id: 52,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/0aad7a04-54e5-46d3-a5db-641160836a4d" },
  { kind: "product",   id: 53,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/03f927ab-a8f0-4a10-bd27-8ffae1e06396" },
  { kind: "product",   id: 54,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/4d08d451-0075-4069-85fa-85954dc56ea1" },
  { kind: "product",   id: 55,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/f7cc6553-77b8-4112-953b-4cd99cc25ea6" },
  { kind: "product",   id: 56,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/23913635-4b4b-4249-b89b-e8d3eb36a532" },
  { kind: "product",   id: 57,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/e0fed32b-085c-4b51-9e3a-b9cd9ecdd7b7" },
  { kind: "product",   id: 58,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/53764b74-33aa-4eef-a8ee-5bb1c9e945b7" },
  { kind: "product",   id: 59,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/fc7e4358-5451-4b38-8ee0-2aa8563ef080" },
  { kind: "product",   id: 60,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/5eaf4d58-0a39-406c-b27f-31b883477823" },
  { kind: "product",   id: 61,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/ac217a3f-62dc-4900-8980-199d5be462d1" },
  { kind: "product",   id: 62,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/df4d3027-8ffe-4aea-b117-161ff95e65a3" },
  { kind: "product",   id: 63,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/48d28a91-b053-4518-918a-acaba0d3b1c3" },
  { kind: "product",   id: 64,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/cfa536eb-831e-4eb1-9b9a-0297ae95e288" },
  { kind: "product",   id: 65,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/586ddebf-4741-406e-952a-22f45d5b5b1c" },
  { kind: "product",   id: 66,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/99dde256-7918-41dd-a48c-d46e77a97a4b" },
  { kind: "product",   id: 67,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/1a95f1f1-b2bb-4e25-8c29-e1db7eb4c58f" },
  { kind: "product",   id: 68,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/19cdd8e3-8717-44c5-9dd7-b56a8c208657" },
  { kind: "product",   id: 69,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/ab197909-380f-42e5-a1e1-9765d6ca5a4d" },
  { kind: "product",   id: 70,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/e6ed6617-f457-47e9-94bf-a516a2c0a334" },
  { kind: "product",   id: 71,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/41382ec5-ce56-4790-8590-ec1fa8e1c350" },
  { kind: "product",   id: 72,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/2deda604-62bf-4ce5-9ace-779991544c4c" },
  { kind: "product",   id: 73,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/d48ee4eb-a77b-4ff0-a417-d6d07d438310" },
  { kind: "product",   id: 74,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/7f365bd3-ff11-4c6b-beef-831d60b1c429" },
  { kind: "product",   id: 76,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/8ddc49fc-b6b4-4b8a-aa53-97d07dbe459e" },
  { kind: "product",   id: 77,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/6cb198c1-58f3-4a4d-80a9-caf2928b4c76" },
  { kind: "product",   id: 78,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/8cc442fd-2461-44e2-bb89-4e146be852e8" },
  { kind: "product",   id: 79,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/a5185dcb-fdca-4f16-89cc-e99ce828085f" },
  { kind: "product",   id: 80,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/96b72a40-7925-4f5f-9592-16a5f29fa0e1" },
  { kind: "product",   id: 81,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/5aff437c-71e3-4975-9cf5-f0bd640f0b47" },
  { kind: "product",   id: 82,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/c4638964-f51f-4ddd-890d-baebacd83a62" },
  { kind: "product",   id: 83,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/06684112-d762-4e46-9e59-d9246ecac474" },
  { kind: "product",   id: 84,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/05927636-4778-40bc-b82d-2038e0d9f9ab" },
  { kind: "product",   id: 85,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/f619668a-0a58-47a6-9e7e-8f0c3649c223" },
  { kind: "product",   id: 86,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/6f50287b-07ef-48e2-b08e-c0e96a33ff86" },
  { kind: "product",   id: 87,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/c94f4cfe-40a4-4591-96ec-374024fdc0c6" },
  { kind: "product",   id: 88,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/d0f46580-313e-4ea2-881a-cf6091319443" },
  { kind: "product",   id: 89,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/21722683-2d8e-4639-b353-2c6e34abb570" },
  { kind: "product",   id: 90,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/95890c4c-8842-48aa-ae52-c1bfca9e6f19" },
  { kind: "product",   id: 91,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/eb2d35a0-2164-4a1e-9f71-c30ed30f305a" },
  { kind: "product",   id: 92,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/c5394866-ac44-4364-a1c6-d6af6f898b71" },
  { kind: "product",   id: 93,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/8a65e103-3efd-4fd6-a3a9-1e8f7973d12b" },
  { kind: "product",   id: 94,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/3213c066-c5a8-4aa2-a3a4-ba9aa44acd1c" },
  { kind: "product",   id: 95,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/934e4d1e-b121-4875-8aa8-354a6a68b01c" },
  { kind: "product",   id: 96,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/080bc026-5b66-4583-bd1f-91490ef0ad86" },
  { kind: "product",   id: 97,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/b5401de0-c571-4ab4-bc0a-59898539b7af" },
  { kind: "product",   id: 98,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/76c7a391-e2d6-479f-9ac5-12c6e11eceea" },
  { kind: "product",   id: 99,  path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/b35b37d0-8f2c-45d3-81df-9669f4c9b6a4" },
  { kind: "product",   id: 100, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/0128a83f-f988-49a4-97db-b95713c2f013" },
  { kind: "product",   id: 101, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/730e183e-abcd-4ab7-a887-9e6ff3957ea0" },
  { kind: "product",   id: 102, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/914cbbc8-20a9-400e-9aa3-ae4f19829a1b" },
  { kind: "product",   id: 103, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/6ea83890-2fc1-400d-84d8-8d13057445a2" },
  { kind: "product",   id: 104, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/7bb0acfa-9e23-46b6-b94a-ac509282bcb5" },
  { kind: "product",   id: 105, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/eb4f2fb3-3db0-48f5-a129-6a9f004211aa" },
  { kind: "product",   id: 106, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/aed5e758-e8a5-4dd8-98fe-c2920639d1c3" },
  { kind: "product",   id: 107, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/8b6c6ba1-f76a-4e00-b5e4-d2e10748b18c" },
  { kind: "product",   id: 108, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/a9db4a9b-db0f-4d83-b7b3-fef5e03e82c3" },
  { kind: "product",   id: 109, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/595b3033-3677-4372-944d-3f19267d705b" },
  { kind: "product",   id: 110, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/3a4c854c-5fcf-4142-95e2-be8a6544361e" },
  { kind: "product",   id: 111, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/653dded1-f1e5-4f98-a8b8-9a53b94fce18" },
  { kind: "product",   id: 112, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/51b6a142-9b91-42a3-a657-57c324e38633" },
  { kind: "product",   id: 113, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/1ae75537-2498-4900-85d0-16c5ed4ec5d9" },
  { kind: "product",   id: 114, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/33acc272-9409-4843-9628-3c5763160c6d" },
  { kind: "product",   id: 115, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/89e817e0-9b0d-4079-95ea-3939e37f956b" },
  { kind: "product",   id: 116, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/c16d461c-0988-4494-9e79-53e9811bece9" },
  { kind: "product",   id: 117, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/69ff61c6-0a08-4562-b65b-f3e71dad4e7b" },
  { kind: "product",   id: 118, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/d13f28c4-6b4f-45e0-bb06-ac304adf2267" },
  { kind: "product",   id: 119, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/ff91ae74-697c-4cdf-89a6-a5b8b7713d09" },
  { kind: "product",   id: 120, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/9b99e9d6-a369-438c-b613-b88b05dd920b" },
  { kind: "product",   id: 121, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/47348b2b-da4f-465c-849b-58f4110970a6" },
  { kind: "product",   id: 122, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/b81e44be-cba9-4eef-a123-35efa563e513" },
  { kind: "product",   id: 123, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/54802c08-30ce-47d1-a11b-916ec48f4a29" },
  { kind: "product",   id: 124, path: "/objects/user_3CtDK0orVuTOHPzofq1OZnDeYbL/products/9d1f4d7f-e4c8-4383-bf19-a81b8a537c3b" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function signGetUrl(objectName) {
  const resp = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: OLD_BUCKET,
      object_name: objectName,
      method: "GET",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sign URL failed (${resp.status}): ${text}`);
  }
  const { signed_url } = await resp.json();
  return signed_url;
}

async function downloadImage(oldPath) {
  // oldPath: /objects/user_OLD/products/UUID
  // GCS objectName: DIR_PREFIX/user_OLD/products/UUID
  const entityId  = oldPath.replace(/^\/objects\//, "");
  const objectName = DIR_PREFIX ? `${DIR_PREFIX}/${entityId}` : entityId;
  const signedUrl  = await signGetUrl(objectName);
  const resp = await fetch(signedUrl);
  if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
  const contentType  = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer  = await resp.arrayBuffer();
  const fileBase64   = Buffer.from(arrayBuffer).toString("base64");
  return { fileBase64, contentType, sizeKB: Math.round(arrayBuffer.byteLength / 1024) };
}

async function sendToNewProject(kind, id, oldPath, fileBase64, contentType) {
  const resp = await fetch(`${NEW_DEV_URL}/api/migrate-receive-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-migration-token": MIGRATION_TOKEN,
    },
    body: JSON.stringify({ kind, id, oldPath, fileBase64, contentType }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Receive failed (${resp.status}): ${JSON.stringify(body)}`);
  return body;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Migrating ${IMAGES.length} images → ${NEW_DEV_URL}`);

  let ok = 0, failed = 0;
  const errors = [];

  for (const { kind, id, path: oldPath } of IMAGES) {
    try {
      process.stdout.write(`  [${kind}/${id}] downloading…`);
      const { fileBase64, contentType, sizeKB } = await downloadImage(oldPath);
      process.stdout.write(` ${sizeKB}KB sending…`);
      const result = await sendToNewProject(kind, id, oldPath, fileBase64, contentType);
      process.stdout.write(` ✓ → ${result.newPath}\n`);
      ok++;
    } catch (err) {
      process.stdout.write(` ✗ ${err.message}\n`);
      errors.push({ kind, id, oldPath, error: err.message });
      failed++;
    }
  }

  console.log(`\nDone: ${ok} succeeded, ${failed} failed`);
  if (errors.length) {
    console.log("Failures:");
    for (const e of errors) console.log(`  ${e.kind}/${e.id}: ${e.error}`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
