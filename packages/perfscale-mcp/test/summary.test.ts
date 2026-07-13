import { describe, expect, it } from "vitest";

import { parseSummary } from "../src/summary.js";

// Test vectors mirror perfscale-core/src/summary.rs so the TS port stays honest.
const NATIVE_OUTPUT = `[sys] Starting 2 VUs for 10s (10s)
vus....................: 2 min=1 max=2
iterations..............: 40 4.00/s
http_req_duration......: avg=0.42ms p(50)=0.31ms p(90)=0.88ms p(95)=1.02ms p(99)=1.90ms min=0.09ms max=3.10ms
http_req_failed........: 5.00%
http_reqs..............: 120 2.00/s
`;

const K6_OUTPUT = `     data_received..................: 1.2 MB 40 kB/s
     data_sent......................: 8.1 kB 270 B/s
     http_req_duration..............: avg=1.42ms min=980µs med=1.30ms max=12.51ms p(90)=1.80ms p(95)=2.10ms
       { expected_response:true }...: avg=1.40ms min=980µs med=1.29ms max=9.11ms p(90)=1.78ms p(95)=2.05ms
     http_req_failed................: 1.35%  ✓ 4    ✗ 292
     http_reqs......................: 296    9.86/s
     iteration_duration.............: avg=1.01s  min=1s  med=1.01s max=1.05s p(90)=1.01s p(95)=1.02s
     iterations.....................: 296    9.86/s
`;

describe("parseSummary", () => {
  it("parses the native engine summary", () => {
    const s = parseSummary(NATIVE_OUTPUT)!;
    expect(s.avg_ms).toBe(0.42);
    expect(s.med_ms).toBe(0.31);
    expect(s.p90_ms).toBe(0.88);
    expect(s.p95_ms).toBe(1.02);
    expect(s.p99_ms).toBe(1.9);
    expect(s.min_ms).toBe(0.09);
    expect(s.max_ms).toBe(3.1);
    expect(s.error_rate).toBeCloseTo(0.05, 9);
    expect(s.total_requests).toBe(120);
    expect(s.requests_per_sec).toBeCloseTo(2.0, 9);
  });

  it("parses a real k6 summary", () => {
    const s = parseSummary(K6_OUTPUT)!;
    expect(s.avg_ms).toBe(1.42);
    expect(s.med_ms).toBe(1.3);
    expect(s.min_ms).toBeCloseTo(0.98, 9);
    expect(s.max_ms).toBe(12.51);
    expect(s.p90_ms).toBe(1.8);
    expect(s.p95_ms).toBe(2.1);
    expect(s.p99_ms).toBeNull();
    expect(s.error_rate).toBeCloseTo(0.0135, 9);
    expect(s.total_requests).toBe(296);
    expect(s.requests_per_sec).toBeCloseTo(9.86, 9);
  });

  it("expected_response line does not override the aggregate", () => {
    expect(parseSummary(K6_OUTPUT)!.max_ms).toBe(12.51);
  });

  it("returns null for output without metrics", () => {
    expect(parseSummary("")).toBeNull();
    expect(parseSummary("[sys] Starting 1 VU for 10s\nrandom noise\n")).toBeNull();
  });

  it("sleep-only run with zero reqs is null", () => {
    const out = "vus....................: 1 min=1 max=1\niterations..............: 10 1.00/s\n";
    expect(parseSummary(out)).toBeNull();
  });

  it("http_reqs prefix variants do not collide", () => {
    expect(parseSummary("http_reqs_custom.......: 999 9.99/s\n")).toBeNull();
  });

  it("normalises seconds and micros to ms", () => {
    const out = `http_req_duration......: avg=1.5s p(50)=250µs p(95)=2s min=1ms max=1m
http_reqs..............: 10 1.00/s
`;
    const s = parseSummary(out)!;
    expect(s.avg_ms).toBe(1500);
    expect(s.med_ms).toBe(0.25);
    expect(s.p95_ms).toBe(2000);
    expect(s.min_ms).toBe(1);
    expect(s.max_ms).toBe(60_000);
  });
});
