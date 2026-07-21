import { describe, expect, it } from "vitest";
import { loadEnv } from "../env.js";
import { routeLimit } from "./rateLimits.js";

const BASE = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  COOKIE_SECRET: "x".repeat(32),
};

describe("routeLimit", () => {
  it("uses the exact production ceiling in production", () => {
    loadEnv({ ...BASE, NODE_ENV: "production" });
    expect(routeLimit(30)).toBe(30);
    expect(routeLimit(5)).toBe(5);
  });

  it("relaxes outside production so suites can re-run without self-throttling", () => {
    // Rate-limit buckets live in Redis and outlive the process. With a hard
    // 30/min share-access cap the integration suite failed on its SECOND run
    // inside a minute — an intermittent failure that looks like a product bug.
    loadEnv({ ...BASE, NODE_ENV: "test" });
    expect(routeLimit(30)).toBeGreaterThan(30);
    loadEnv({ ...BASE, NODE_ENV: "development" });
    expect(routeLimit(30)).toBeGreaterThan(30);
  });

  it("never returns zero or a negative ceiling — the limiter must stay active", () => {
    for (const nodeEnv of ["production", "test", "development"]) {
      loadEnv({ ...BASE, NODE_ENV: nodeEnv });
      expect(routeLimit(1)).toBeGreaterThan(0);
    }
  });
});
