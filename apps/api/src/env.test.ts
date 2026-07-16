import { describe, expect, it } from "vitest";
import { loadEnv, trustProxyConfig } from "./env.js";

const BASE = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  COOKIE_SECRET: "x".repeat(32),
};

describe("trustProxyConfig", () => {
  it("defaults to false so a forged X-Forwarded-For cannot bypass IP rate limits", () => {
    loadEnv({ ...BASE, TRUST_PROXY: undefined });
    expect(trustProxyConfig()).toBe(false);
  });

  it("treats an empty value as false", () => {
    loadEnv({ ...BASE, TRUST_PROXY: "  " });
    expect(trustProxyConfig()).toBe(false);
  });

  it("parses a proxy allowlist", () => {
    loadEnv({ ...BASE, TRUST_PROXY: "10.0.0.1, 192.168.1.0/24" });
    expect(trustProxyConfig()).toEqual(["10.0.0.1", "192.168.1.0/24"]);
  });

  it("allows explicit true for closed networks", () => {
    loadEnv({ ...BASE, TRUST_PROXY: "true" });
    expect(trustProxyConfig()).toBe(true);
  });
});

describe("env validation", () => {
  it("refuses to boot with a short cookie secret", () => {
    expect(() => loadEnv({ ...BASE, COOKIE_SECRET: "too-short" })).toThrow(
      /COOKIE_SECRET/,
    );
  });

  it("refuses to boot without a database url", () => {
    expect(() => loadEnv({ ...BASE, DATABASE_URL: "" })).toThrow(
      /DATABASE_URL/,
    );
  });
});
