import { defineConfig,devices } from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:process.env.SYSTEM_RFB_MODE==='1'?'rfb-system.spec.ts':'system.spec.ts',workers:1,retries:0,timeout:150_000,forbidOnly:true,
  reporter:[['list'],['html',{outputFolder:'playwright-report/system',open:'never'}]],
  outputDir:'test-results/system',
  use:{...devices['Desktop Chrome'],baseURL:process.env.SYSTEM_URL,trace:'retain-on-failure',
    launchOptions:process.env.SYSTEM_RFB_MODE==='1'?{args:['--host-resolver-rules=MAP rfb-http.test 127.0.0.1']}:{},
  },
});
