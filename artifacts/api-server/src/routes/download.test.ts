import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@clerk/express", () => ({
  getAuth: () => ({}),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import downloadRouter, {
  MAC_BUILD_SCRIPT,
  getScannerAgentRelease,
} from "./download";

const app = express();
app.use(downloadRouter);

describe("macOS Print Agent download", () => {
  it("uses the checked-in packaging script", () => {
    expect(MAC_BUILD_SCRIPT).toBe(
      path.resolve(
        import.meta.dirname,
        "../../../..",
        "scripts",
        "build-mac-zip.sh",
      ),
    );
    expect(fs.existsSync(MAC_BUILD_SCRIPT)).toBe(true);
  });

  it("builds and serves a valid PrintAgent.zip", async () => {
    const response = await request(app)
      .get("/download/mac")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/zip/);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="PrintAgent.zip"',
    );
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body.subarray(0, 2).toString()).toBe("PK");
    expect(response.body.includes(Buffer.from("PrintAgent/Install.command"))).toBe(
      true,
    );
    expect(response.body.includes(Buffer.from("PrintAgent/Uninstall.command"))).toBe(
      true,
    );
  });
});

describe("Windows Scanner Agent download", () => {
  it("reports an explicit unavailable state until a release is configured", async () => {
    vi.stubEnv("SCANNER_AGENT_RELEASE_URL", "");
    vi.stubEnv("SCANNER_AGENT_RELEASE_FILENAME", "");
    vi.stubEnv("SCANNER_AGENT_RELEASE_VERSION", "");
    vi.stubEnv("SCANNER_AGENT_RELEASE_SHA256", "");

    const version = await request(app).get("/download/scanner-agent/version");
    expect(version.status).toBe(200);
    expect(version.body).toMatchObject({
      available: false,
      reason: "The Windows Scanner Agent has not been published yet.",
    });

    const download = await request(app).get("/download/scanner-agent");
    expect(download.status).toBe(503);
    expect(download.body.code).toBe("scanner_agent_unavailable");
  });

  it("redirects to the configured versioned x64 installer", async () => {
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_URL",
      "https://github.com/Saade09/Presentail-Scanner-Agent/releases/download/scanner-agent-v1.0.3/Presentail-Scanner-Agent-1.0.3-x64.exe",
    );
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_FILENAME",
      "Presentail-Scanner-Agent-1.0.3-x64.exe",
    );
    vi.stubEnv("SCANNER_AGENT_RELEASE_VERSION", "1.0.3");
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_SHA256",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    expect(getScannerAgentRelease()).toMatchObject({
      available: true,
      version: "1.0.3",
      filename: "Presentail-Scanner-Agent-1.0.3-x64.exe",
    });

    const response = await request(app)
      .get("/download/scanner-agent")
      .redirects(0);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain(
      "Presentail-Scanner-Agent-1.0.3-x64.exe",
    );
    expect(response.headers["content-type"]).toMatch(
      /^application\/octet-stream/,
    );
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="Presentail-Scanner-Agent-1.0.3-x64.exe"',
    );
  });

  it("refuses to advertise an installer that predates configurable inbox support", () => {
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_URL",
      "https://github.com/Saade09/Presentail-Scanner-Agent/releases/download/scanner-agent-v1.0.2/Presentail-Scanner-Agent-1.0.2-x64.exe",
    );
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_FILENAME",
      "Presentail-Scanner-Agent-1.0.2-x64.exe",
    );
    vi.stubEnv("SCANNER_AGENT_RELEASE_VERSION", "1.0.2");
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_SHA256",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    expect(getScannerAgentRelease()).toMatchObject({
      available: false,
      version: "1.0.2",
      reason:
        "The published Scanner Agent predates configurable inbox support. Publish version 1.0.3 or newer.",
    });
  });

  it("requires the download URL to use the matching immutable release tag", () => {
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_URL",
      "https://github.com/Saade09/Presentail-Scanner-Agent/releases/download/scanner-agent-current/Presentail-Scanner-Agent-1.0.3-x64.exe",
    );
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_FILENAME",
      "Presentail-Scanner-Agent-1.0.3-x64.exe",
    );
    vi.stubEnv("SCANNER_AGENT_RELEASE_VERSION", "1.0.3");
    vi.stubEnv(
      "SCANNER_AGENT_RELEASE_SHA256",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    expect(getScannerAgentRelease()).toMatchObject({
      available: false,
      reason:
        "The Scanner Agent release URL does not match its immutable version tag.",
    });
  });
});