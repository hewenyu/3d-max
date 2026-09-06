import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 240000,
  expect: { timeout: 15000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx concurrently -k -n api,web "tsx server/index.ts" "vite --host 127.0.0.1"',
    url: 'http://127.0.0.1:5180/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '4180',
      WEB_PORT: '5180',
      APP_URL: 'http://127.0.0.1:5180',
      WHITEFRAME_DATA_DIR: resolve('.data/e2e'),
    },
  },
});
