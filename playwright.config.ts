import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/acceptance",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    channel: process.env.CI ? "chromium" : "msedge",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
