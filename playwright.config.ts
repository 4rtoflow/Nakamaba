import { defineConfig } from '@playwright/test';

const ADMIN_PORT = 4100;

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    channel: 'chrome',
    headless: true,
    locale: 'ja-JP',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx scripts/dev-server.ts',
    url: `http://127.0.0.1:${ADMIN_PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: { DEV_STATE_FILE: 'test-results/state/e2e-state.json' },
  },
});
