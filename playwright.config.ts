import { defineConfig } from '@playwright/test';

// Browser tests against the real Silent Disco binary (see e2e/station.ts).
// Run with `npm run test:e2e`, which builds the app first.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts', // keeps vitest and Playwright apart
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
});
