import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolvePublicUrlAddress = vi.fn();
const mockHttpsRequest = vi.fn();

vi.mock("./urlValidator", () => ({
  resolvePublicUrlAddress: (...args: unknown[]) => mockResolvePublicUrlAddress(...args),
}));

vi.mock("node:https", () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

import { publicWebhookFetch } from "./publicWebhookFetch";

describe("publicWebhookFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePublicUrlAddress.mockResolvedValue({ address: "93.184.216.34", family: 4 });
  });

  it("pins the HTTPS connection to the validated address", async () => {
    mockHttpsRequest.mockImplementation((_target: URL, options: Record<string, unknown>, onResponse: (response: EventEmitter & {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string>;
    }) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: () => void;
        destroy: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        response.statusCode = 204;
        response.statusMessage = "No Content";
        response.headers = {};
        onResponse(response);
        response.emit("end");
      };

      const lookup = options.lookup as (
        hostname: string,
        options: unknown,
        callback: (error: Error | null, address: string, family: number) => void,
      ) => void;
      const callback = vi.fn();
      lookup("hooks.example.test", {}, callback);
      expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
      return request;
    });

    const response = await publicWebhookFetch("https://hooks.example.test/event", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(204);
    expect(mockResolvePublicUrlAddress).toHaveBeenCalledWith("https://hooks.example.test/event");
  });

  it("returns redirects to the caller instead of following their Location", async () => {
    mockHttpsRequest.mockImplementation((_target: URL, _options: unknown, onResponse: (response: EventEmitter & {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string>;
    }) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: () => void;
        destroy: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        };
        response.statusCode = 302;
        response.statusMessage = "Found";
        response.headers = { location: "http://169.254.169.254/latest/meta-data" };
        onResponse(response);
        response.emit("end");
      };
      return request;
    });

    const response = await publicWebhookFetch("https://hooks.example.test/event", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data");
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
  });

  it("caps an oversized response body and removes the abort listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    mockHttpsRequest.mockImplementation((_target: URL, _options: unknown, onResponse: (response: EventEmitter & {
      statusCode: number;
      statusMessage: string;
      headers: Record<string, string>;
      destroy: ReturnType<typeof vi.fn>;
    }) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: () => void;
        destroy: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
          destroy: ReturnType<typeof vi.fn>;
        };
        response.statusCode = 200;
        response.statusMessage = "OK";
        response.headers = {};
        response.destroy = vi.fn();
        onResponse(response);
        response.emit("data", Buffer.alloc(5000, "a"));
        expect(response.destroy).toHaveBeenCalledTimes(1);
      };
      return request;
    });

    const response = await publicWebhookFetch("https://hooks.example.test/event", {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });

    expect((await response.text()).length).toBe(2000);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});