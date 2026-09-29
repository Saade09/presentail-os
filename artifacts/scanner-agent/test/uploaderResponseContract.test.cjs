const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const axios = require("axios");
const { uploadFile } = require("../dist/lib/uploader.js");

function withScan(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-response-"));
  const scanPath = path.join(root, "invoice.pdf");
  fs.writeFileSync(scanPath, "%PDF response contract");
  return Promise.resolve(run(scanPath)).finally(() =>
    fs.rmSync(root, { recursive: true, force: true }),
  );
}

test("only accepts 202 when durable source storage is confirmed", async () => {
  const originalPost = axios.post;
  axios.post = async () => ({ status: 202, data: { import_id: 12 } });
  try {
    await withScan(async (scanPath) => {
      const result = await uploadFile("https://os.example.test", "token", scanPath, "1.0.4");
      assert.equal(result.kind, "recoverable");
      assert.match(result.reason, /durable source storage/i);
    });
  } finally {
    axios.post = originalPost;
  }
});

test("only archives a duplicate when its source was verified", async () => {
  const originalPost = axios.post;
  axios.post = async () => ({
    status: 200,
    data: { duplicate: true, import_id: 12, source_verified: false },
  });
  try {
    await withScan(async (scanPath) => {
      const result = await uploadFile("https://os.example.test", "token", scanPath, "1.0.4");
      assert.equal(result.kind, "recoverable");
      assert.match(result.reason, /verify durable source storage/i);
    });
  } finally {
    axios.post = originalPost;
  }
});

test("accepts explicit durable and verified responses", async () => {
  const originalPost = axios.post;
  try {
    axios.post = async () => ({
      status: 202,
      data: { import_id: 12, source_stored: true },
    });
    await withScan(async (scanPath) => {
      assert.equal(
        (await uploadFile("https://os.example.test", "token", scanPath, "1.0.4")).kind,
        "success",
      );
    });

    axios.post = async () => ({
      status: 200,
      data: { duplicate: true, import_id: 12, source_verified: true },
    });
    await withScan(async (scanPath) => {
      assert.equal(
        (await uploadFile("https://os.example.test", "token", scanPath, "1.0.4")).kind,
        "duplicate",
      );
    });
  } finally {
    axios.post = originalPost;
  }
});