import { env } from "../env.js";

/**
 * Per-route rate-limit ceiling.
 *
 * Production values are the ones that ship and are the real anti-abuse
 * control. In dev/test they are multiplied so a suite can be re-run
 * back-to-back without throttling itself: rate-limit buckets live in Redis and
 * outlive the process, so a hard 30/min share-access cap makes the integration
 * suite fail on its second run within a minute — a flake that looks like a
 * product bug and would be intermittent in CI.
 *
 * Deliberately NOT disabled outside production: the limiter still runs, so its
 * headers and 429 path stay exercised. Only the ceiling moves.
 */
export function routeLimit(productionMax: number): number {
  return env().NODE_ENV === "production" ? productionMax : productionMax * 100;
}
