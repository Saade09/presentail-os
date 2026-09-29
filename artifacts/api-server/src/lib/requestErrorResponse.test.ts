import { describe, expect, it } from "vitest";
import { CorsOriginDeniedError } from "./corsOrigins";
import { expectedRequestErrorResponse } from "./requestErrorResponse";

describe("expectedRequestErrorResponse", () => {
  it("maps an untrusted browser origin to a specific 403", () => {
    expect(
      expectedRequestErrorResponse(
        new CorsOriginDeniedError("https://attacker.example"),
      ),
    ).toEqual({
      status: 403,
      body: {
        error: "Request origin is not allowed.",
        code: "CORS_ORIGIN_DENIED",
      },
    });
  });

  it.each([
    [
      Object.assign(new Error("too large"), { type: "entity.too.large" }),
      413,
      "REQUEST_BODY_TOO_LARGE",
    ],
    [
      Object.assign(new SyntaxError("bad json"), {
        type: "entity.parse.failed",
        status: 400,
      }),
      400,
      "INVALID_JSON",
    ],
    [
      Object.assign(new Error("unsupported"), {
        type: "encoding.unsupported",
      }),
      415,
      "UNSUPPORTED_CONTENT_ENCODING",
    ],
  ])("maps expected body-parser failures", (error, status, code) => {
    expect(expectedRequestErrorResponse(error)).toMatchObject({
      status,
      body: { code },
    });
  });

  it("leaves unexpected application failures for the 500 handler", () => {
    expect(expectedRequestErrorResponse(new Error("database unavailable"))).toBe(
      null,
    );
  });
});