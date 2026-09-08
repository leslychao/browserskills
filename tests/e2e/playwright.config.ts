import { defineConfig,devices } from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:'frontend.spec.ts',fullyParallel:false,workers:1,forbidOnly:!!process.env.CI,retries:0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{...devices['Desktop Chrome'],baseURL:'http://127.0.0.1:4173',trace:'retain-on-failure'},
  webServer:{command:'npm run dev --workspace @browserskills/web -- --port 4173 --strictPort',url:'http://127.0.0.1:4173',reuseExistingServer:!process.env.CI},
});
