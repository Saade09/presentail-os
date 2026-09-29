import { request as httpsRequest } from "node:https";
import { resolvePublicUrlAddress } from "./urlValidator";

const MAX_RESPONSE_BYTES = 2000;

/**
 * Sends a request to a public HTTPS webhook without a second DNS lookup.
 * Node's https client does not follow redirects, so a 3xx response remains a
 * failed delivery rather than crossing the validated destination boundary.
 */
export async function publicWebhookFetch(
  rawUrl: string,
  init: RequestInit,
): Promise<Response> {
  const target = new URL(rawUrl);
  const pinnedAddress = await resolvePublicUrlAddress(rawUrl);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let abort: (() => void) | undefined;
    const cleanup = () => {
      if (abort) init.signal?.removeEventListener("abort", abort);
    };
    const settleResolve = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const request = httpsRequest(
      target,
      {
        method: init.method ?? "POST",
        headers: init.headers as Record<string, string> | undefined,
        lookup: (_hostname, _options, callback) => {
          callback(null, pinnedAddress.address, pinnedAddress.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        const finish = () => {
          if (settled) return;
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => headers.append(name, item));
            } else if (value !== undefined) {
              headers.set(name, String(value));
            }
          }
          const status = response.statusCode ?? 500;
          const responseBody = status === 204 || status === 205 || status === 304
            ? null
            : Buffer.concat(chunks);
          settleResolve(new Response(responseBody, {
            status,
            statusText: response.statusMessage,
            headers,
          }));
        };
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = MAX_RESPONSE_BYTES - bytesRead;
          if (remaining > 0) {
            const retained = buffer.subarray(0, remaining);
            chunks.push(retained);
            bytesRead += retained.length;
          }
          if (buffer.length > remaining) {
            finish();
            response.destroy();
          }
        });
        response.on("end", finish);
        response.on("error", settleReject);
      },
    );

    abort = () => {
      const reason = init.signal?.reason;
      request.destroy(reason instanceof Error ? reason : new Error("webhook request aborted"));
    };
    if (init.signal?.aborted) {
      abort();
      return;
    } else {
      init.signal?.addEventListener("abort", abort, { once: true });
    }
    request.on("error", settleReject);
    if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
      request.write(init.body);
    } else if (init.body != null) {
      request.destroy(new Error("unsupported webhook request body"));
      return;
    }
    request.end();
  });
}