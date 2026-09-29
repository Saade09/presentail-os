import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

async function reservePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a production-entry smoke-test port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForStatus(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  timeoutMs = 30_000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.status === expectedStatus) return response;
      lastError = new Error(`Expected ${expectedStatus}, received ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw lastError ?? new Error(`Timed out waiting for ${expectedStatus}`);
}

describe("exact production entrypoint", () => {
  let child: ChildProcess | undefined;

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  it("contains startup traffic, accepts production CORS, and reaches auth after DB readiness", async () => {
    const port = await reservePort();
    const entrypoint = resolve(import.meta.dirname, "../production-entry.cjs");
    const { NODE_ENV: _ignoredNodeEnv, PORT: _ignoredPort, ...inheritedEnv } =
      process.env;
    child = spawn(process.execPath, [entrypoint], {
      env: {
        ...inheritedEnv,
        PORT: String(port),
        ENABLE_MERCHANT_WORKER: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForStatus(`${baseUrl}/api/healthz`, {}, 200);

    const preflight = await fetch(`${baseUrl}/api/products`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://os.presentail.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://os.presentail.com",
    );

    const startupWrite = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: {
        Origin: "https://os.presentail.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect([401, 503]).toContain(startupWrite.status);
    if (startupWrite.status === 503) {
      expect(await startupWrite.json()).toMatchObject({
        code: "startup_in_progress",
      });
    }

    const readyWrite = await waitForStatus(
      `${baseUrl}/api/products`,
      {
        method: "POST",
        headers: {
          Origin: "https://os.presentail.com",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      401,
      45_000,
    );
    expect(await readyWrite.json()).toMatchObject({ error: "Unauthorized" });

    const denied = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "CORS_ORIGIN_DENIED" });
    expect(output).not.toContain("UnhandledPromiseRejection");
  }, 60_000);
});