import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/test/**/*.test.ts"],
    environment: "node",
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://liveread:liveread@localhost:5433/liveread",
      REDIS_URL: process.env["REDIS_URL"] ?? "redis://localhost:6379",
      S3_ENDPOINT: process.env["S3_ENDPOINT"] ?? "http://localhost:9000",
      S3_ACCESS_KEY: "liveread",
      S3_SECRET_KEY: "liveread-secret",
      S3_BUCKET: "liveread-recordings",
      SMTP_URL: "smtp://localhost:1025",
      COOKIE_SECRET: "test-cookie-secret-at-least-32-chars!!",
      WEB_ORIGINS: "http://localhost:3000",
      APP_BASE_URL: "http://localhost:3000",
      STT_PROVIDER: "fake",
      EMAIL_AUTOVERIFY: "true",
      LOG_LEVEL: "silent",
      // real production knob, turned down so revocation/expiry re-checks are
      // observable within a test's lifetime rather than 15s later
      VIEWER_REAUTH_INTERVAL_MS: "300",
    },
  },
});
