import { CorsOriginDeniedError } from "./corsOrigins";

type RequestErrorResponse = {
  status: number;
  body: {
    error: string;
    code: string;
  };
};

type BodyParserError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
};

export function expectedRequestErrorResponse(
  error: unknown,
): RequestErrorResponse | null {
  if (error instanceof CorsOriginDeniedError) {
    return {
      status: 403,
      body: {
        error: "Request origin is not allowed.",
        code: error.code,
      },
    };
  }

  if (!(error instanceof Error)) return null;

  const bodyError = error as BodyParserError;
  if (
    bodyError.type === "entity.too.large" ||
    bodyError.status === 413 ||
    bodyError.statusCode === 413
  ) {
    return {
      status: 413,
      body: {
        error: "Request body is too large.",
        code: "REQUEST_BODY_TOO_LARGE",
      },
    };
  }

  if (
    bodyError.type === "entity.parse.failed" ||
    (error instanceof SyntaxError && bodyError.status === 400)
  ) {
    return {
      status: 400,
      body: {
        error: "Request body contains invalid JSON.",
        code: "INVALID_JSON",
      },
    };
  }

  if (
    bodyError.type === "encoding.unsupported" ||
    bodyError.status === 415 ||
    bodyError.statusCode === 415
  ) {
    return {
      status: 415,
      body: {
        error: "Request content encoding is not supported.",
        code: "UNSUPPORTED_CONTENT_ENCODING",
      },
    };
  }

  return null;
}