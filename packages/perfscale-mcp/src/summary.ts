/**
 * k6-compatible summary parser — a faithful TypeScript port of
 * perfscale-core/src/summary.rs (`parse_summary`). All three engines
 * (k6, locust, native) emit this text format.
 */

export interface RunSummary {
  avg_ms: number | null;
  med_ms: number | null;
  p90_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  /** `http_req_failed` as a fraction in 0.0..=1.0 */
  error_rate: number;
  total_requests: number;
  requests_per_sec: number;
}

/**
 * Match `name`, optional dot padding, `:`, and return the value part.
 * Rejects prefix collisions like `http_reqs_failed` by requiring the char
 * right after `name` to be padding or the separator.
 */
function metricValue(line: string, name: string): string | null {
  if (!line.startsWith(name)) return null;
  const rest = line.slice(name.length);
  const next = rest[0];
  if (next !== "." && next !== ":" && next !== " ") return null;
  const after = rest.replace(/^\.*/, "").trimStart();
  if (!after.startsWith(":")) return null;
  return after.slice(1).trimStart();
}

/** Extract a duration token like `avg=1.42ms`, `p(95)=1.02s`, `min=980µs` → ms. */
function extractMs(line: string, prefix: string): number | null {
  const start = line.indexOf(prefix);
  if (start === -1) return null;
  const rest = line.slice(start + prefix.length);
  const wsIdx = rest.search(/\s/);
  const token = wsIdx === -1 ? rest : rest.slice(0, wsIdx);

  const suffixes: Array<[string, number]> = [
    ["ms", 1],
    ["µs", 1 / 1000],
    ["us", 1 / 1000],
    ["m", 60_000],
    ["s", 1000],
  ];
  for (const [suffix, factor] of suffixes) {
    if (token.endsWith(suffix)) {
      const v = Number(token.slice(0, -suffix.length));
      return Number.isFinite(v) ? v * factor : null;
    }
  }
  const v = Number(token);
  return Number.isFinite(v) && token !== "" ? v : null;
}

/**
 * Parse a k6-compatible summary out of raw run output. Returns null when no
 * request metrics were found at all.
 */
export function parseSummary(output: string): RunSummary | null {
  const s: RunSummary = {
    avg_ms: null,
    med_ms: null,
    p90_ms: null,
    p95_ms: null,
    p99_ms: null,
    min_ms: null,
    max_ms: null,
    error_rate: 0,
    total_requests: 0,
    requests_per_sec: 0,
  };

  for (const line of output.split("\n")) {
    const t = line.trim();

    // k6 prints a second `http_req_duration{expected_response:true}` line —
    // skip it so the unfiltered aggregate wins.
    if (t.includes("http_req_duration") && !t.includes("expected_response")) {
      s.avg_ms = extractMs(t, "avg=") ?? s.avg_ms;
      s.med_ms = extractMs(t, "p(50)=") ?? extractMs(t, "med=") ?? s.med_ms;
      s.p90_ms = extractMs(t, "p(90)=") ?? s.p90_ms;
      s.p95_ms = extractMs(t, "p(95)=") ?? s.p95_ms;
      s.p99_ms = extractMs(t, "p(99)=") ?? s.p99_ms;
      s.min_ms = extractMs(t, "min=") ?? s.min_ms;
      s.max_ms = extractMs(t, "max=") ?? s.max_ms;
    }

    const reqs = metricValue(t, "http_reqs");
    if (reqs !== null) {
      const parts = reqs.split(/\s+/).filter(Boolean);
      if (parts.length >= 1) s.total_requests = Number(parts[0]) || 0;
      if (parts.length >= 2) {
        s.requests_per_sec = Number(parts[1].replace(/\/s$/, "")) || 0;
      }
    }

    const failed = metricValue(t, "http_req_failed");
    if (failed !== null) {
      const chunk = failed.split(/\s+/)[0] ?? "0%";
      s.error_rate = (Number(chunk.replace(/%$/, "")) || 0) / 100;
    }
  }

  return s.total_requests > 0 || s.requests_per_sec > 0 ? s : null;
}
