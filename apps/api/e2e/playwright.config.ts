import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  // These suites are PR gates (`golden-flow-e2e`, `issue-radar-e2e`). One
  // retry on CI only: on a shared runner an unrelated flake (a preview-stop
  // timeout, hit once in three local runs on an idle machine) turns into a
  // recurring red PR on unrelated work. Locally 0 — a flake there is signal.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
});
