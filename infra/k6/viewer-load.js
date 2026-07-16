import http from "k6/http";
import { check, sleep } from "k6";

/**
 * Load test for the read-heavy hot path: many viewers replaying a session's
 * transcript, plus a concurrent share-token abuse probe.
 *
 * IMPORTANT — what this does and does not measure:
 *  - k6 runs from a SINGLE source IP, but LiveRead rate limits per client IP
 *    by design (anti-enumeration). To simulate distinct viewers, each VU sends
 *    its own X-Forwarded-For — which the API honours ONLY when TRUST_PROXY is
 *    configured, exactly as it would behind a real load balancer. `make
 *    test-load` starts the API with TRUST_PROXY=true for this reason. With the
 *    production default (TRUST_PROXY=false) these headers are ignored and the
 *    limiter correctly throttles the single real source IP.
 *  - This is a single-machine test against a local Docker stack. It is not a
 *    substitute for a distributed load test against a regional deployment.
 *
 * Usage: make test-load   (requires the demo seed)
 */

const API = __ENV.API_URL || "http://localhost:4000";
const SHARE_ID = __ENV.SHARE_ID || "demo-reading-2026";
const SHARE_TOKEN = __ENV.SHARE_TOKEN || "demo-share-token-public";

export const options = {
  scenarios: {
    viewers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 50 },
        { duration: "30s", target: 50 },
        { duration: "5s", target: 0 },
      ],
      exec: "viewerReplay",
    },
    abuse: {
      executor: "constant-vus",
      vus: 5,
      duration: "50s",
      exec: "tokenAbuse",
    },
  },
  thresholds: {
    "http_req_duration{scenario:viewers}": ["p(95)<500"],
    "checks{scenario:viewers}": ["rate>0.95"],
    "checks{scenario:abuse}": ["rate>0.95"],
  },
};

/** Unique per-VU client IP so each simulated viewer gets its own bucket. */
function viewerIp() {
  const id = __VU;
  return `203.0.113.${(id % 254) + 1}`;
}

export function setup() {
  const access = http.post(
    `${API}/v1/share/${SHARE_ID}/access`,
    JSON.stringify({ token: SHARE_TOKEN }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.250",
      },
    },
  );
  if (access.status !== 200) {
    throw new Error(
      `setup failed: share access returned ${access.status}. Run the demo seed first.`,
    );
  }
  return { viewerToken: access.json("viewerToken") };
}

export function viewerReplay(data) {
  const res = http.get(
    `${API}/v1/share/${SHARE_ID}/transcript?token=${data.viewerToken}&after=-1`,
    { headers: { "X-Forwarded-For": viewerIp() } },
  );
  check(res, {
    "replay 200": (r) => r.status === 200,
    "replay has events": (r) => (r.json("events") || []).length > 0,
  });
  sleep(0.5 + Math.random() * 0.5);
}

/** Confirms token guessing is refused (404) or throttled (429) — never 200. */
export function tokenAbuse() {
  const res = http.post(
    `${API}/v1/share/${SHARE_ID}/access`,
    JSON.stringify({ token: `guess-${Math.random()}` }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `198.51.100.${(__VU % 254) + 1}`,
      },
    },
  );
  check(res, {
    "guessed token never granted": (r) => r.status !== 200,
    "rejected or throttled": (r) => r.status === 404 || r.status === 429,
  });
  sleep(0.3);
}
