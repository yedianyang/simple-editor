import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:1420' },
  webServer: {
    command: 'npm run tauri:dev',
    url: 'http://localhost:1420',
    reuseExistingServer: true,
  },
});
