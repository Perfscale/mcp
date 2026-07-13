/**
 * HTTP client for the controlplane BFF (/api/v1).
 *
 * Auth: a personal API token (`psk_...`) created in the dashboard under
 * Settings → API Tokens (Scale: 1 per user, Enterprise: 5 per user).
 */

export interface ClientOptions {
  /** Base URL, e.g. https://perfscale.su — PERFSCALE_API_URL */
  baseUrl: string;
  /** API token (psk_...) — PERFSCALE_API_TOKEN */
  token: string;
  fetchFn?: typeof fetch;
}

export class ControlplaneError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlplaneError";
  }
}

export class ControlplaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  static fromEnv(fetchFn?: typeof fetch): ControlplaneClient {
    const token = process.env.PERFSCALE_API_TOKEN;
    if (!token) {
      throw new Error(
        "PERFSCALE_API_TOKEN is not set. Create a token in the dashboard: " +
          "Settings → API Tokens (requires the Scale or Enterprise plan).",
      );
    }
    // An empty PERFSCALE_API_URL counts as unset.
    const baseUrl = process.env.PERFSCALE_API_URL || "https://perfscale.su";
    return new ControlplaneClient({ baseUrl, token, fetchFn });
  }

  url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.fetchFn(this.url(path, opts.query), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string; code?: string };
        if (body.message) message = `${body.code ?? res.status}: ${body.message}`;
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 401) {
        message +=
          " — check PERFSCALE_API_TOKEN (revoked/expired?) and that the token's " +
          "workspace is your active workspace";
      }
      throw new ControlplaneError(res.status, message);
    }
    return (await res.json()) as T;
  }

  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }
}

/** Mask env var values — the MCP surface never exposes secrets. */
export function maskEnvVars<T extends { value?: string }>(vars: T[]): T[] {
  return vars.map((v) => ({ ...v, value: v.value !== undefined ? "***" : undefined }));
}
