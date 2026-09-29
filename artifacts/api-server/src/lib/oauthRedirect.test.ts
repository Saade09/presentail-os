import { describe, it, expect } from "vitest";
import { externalOrigin } from "./oauthRedirect";

describe("externalOrigin", () => {
  it("forces https for a non-localhost host even when req.protocol is http", () => {
    expect(externalOrigin({ protocol: "http", hostname: "os.presentail.com" })).toBe(
      "https://os.presentail.com",
    );
  });

  it("keeps https when the proxy forwarded https", () => {
    expect(externalOrigin({ protocol: "https", hostname: "os.presentail.com" })).toBe(
      "https://os.presentail.com",
    );
  });

  it("allows plain http for localhost dev", () => {
    expect(externalOrigin({ protocol: "http", hostname: "localhost" })).toBe(
      "http://localhost",
    );
    expect(externalOrigin({ protocol: "http", hostname: "127.0.0.1" })).toBe(
      "http://127.0.0.1",
    );
    expect(externalOrigin({ protocol: "http", hostname: "api.localhost" })).toBe(
      "http://api.localhost",
    );
  });
});
