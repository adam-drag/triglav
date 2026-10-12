import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests against a running orchestrator. They do not start it:
 * run `pnpm e2e:up` first (a throwaway stack on :7401), or point ORCH_E2E_URL at another one.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e-results',
  globalSetup: './e2e/preflight.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]],
  use: {
    baseURL: process.env.ORCH_E2E_URL ?? 'http://localhost:7401',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
