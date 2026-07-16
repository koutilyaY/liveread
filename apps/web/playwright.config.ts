import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests expect the stack to be running:
 *   docker compose up -d postgres redis minio mailpit
 *   API on :4000 (EMAIL_AUTOVERIFY=true, STT_PROVIDER=fake)
 *   web on :3000
 * `make test-e2e` handles this. Chromium runs with fake media devices so
 * getUserMedia succeeds headlessly; viewer speech uses the deterministic
 * fake driver (?fakespeech=1).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-capture",
            "--use-fake-device-for-media-capture",
          ],
        },
        permissions: ["microphone"],
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: {
            "permissions.default.microphone": 1,
            "media.navigator.streams.fake": true,
          },
        },
      },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
