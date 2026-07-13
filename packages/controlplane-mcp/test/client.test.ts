import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlplaneClient, ControlplaneError, maskEnvVars } from "../src/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch, baseUrl = "https://perfscale.su") {
  return new ControlplaneClient({ baseUrl, token: "psk_testtoken", fetchFn });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ControlplaneClient", () => {
  it("builds /api/v1 URLs and strips trailing slashes", () => {
    const c = makeClient(fetch, "https://perfscale.ru///");
    expect(c.url("/machines")).toBe("https://perfscale.ru/api/v1/machines");
  });

  it("serialises query params and skips undefined", () => {
    const c = makeClient(fetch);
    const url = c.url("/metrics/query", { metric: "cpu", step: 60, from: undefined });
    expect(url).toBe("https://perfscale.su/api/v1/metrics/query?metric=cpu&step=60");
  });

  it("sends the bearer token", async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer psk_testtoken",
      );
      return jsonResponse([]);
    });
    await makeClient(fetchFn as unknown as typeof fetch).get("/machines");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("POSTs JSON bodies", async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ machine: ["m1"], test: "t1" });
      return jsonResponse({ streams: {} });
    });
    await makeClient(fetchFn as unknown as typeof fetch).post("/test/run", {
      machine: ["m1"],
      test: "t1",
    });
  });

  it("surfaces API error messages with codes", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ code: "TOKEN_LIMIT_REACHED", message: "limit reached" }, 403),
    );
    await expect(makeClient(fetchFn as unknown as typeof fetch).get("/api-tokens")).rejects.toThrow(
      /TOKEN_LIMIT_REACHED: limit reached/,
    );
  });

  it("adds token guidance on 401", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: "unauthorized" }, 401));
    const err = await makeClient(fetchFn as unknown as typeof fetch)
      .get("/machines")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlplaneError);
    expect((err as ControlplaneError).status).toBe(401);
    expect((err as Error).message).toMatch(/PERFSCALE_API_TOKEN/);
  });

  it("fromEnv requires PERFSCALE_API_TOKEN", () => {
    vi.stubEnv("PERFSCALE_API_TOKEN", "");
    expect(() => ControlplaneClient.fromEnv()).toThrow(/Settings → API Tokens/);
  });

  it("fromEnv defaults the base URL to perfscale.su", () => {
    vi.stubEnv("PERFSCALE_API_TOKEN", "psk_x");
    vi.stubEnv("PERFSCALE_API_URL", "");
    const c = ControlplaneClient.fromEnv();
    expect(c.url("/health")).toBe("https://perfscale.su/api/v1/health");
  });
});

describe("maskEnvVars", () => {
  it("masks values but keeps keys", () => {
    const masked = maskEnvVars([
      { key: "API_SECRET", value: "s3cr3t" } as { key: string; value?: string },
    ]);
    expect(masked[0]).toEqual({ key: "API_SECRET", value: "***" });
  });
});
