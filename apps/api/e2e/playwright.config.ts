import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  // Applies to every spec in this config, not only the two that are PR gates
  // (`golden-flow-e2e`, `issue-radar-e2e`) — a global default is right here.
  // One retry on CI only: on a shared runner an unrelated flake (a
  // preview-stop timeout, which reproduced repeatedly under concurrent load
  // and not at all on an idle machine) turns into a recurring red PR on work
  // that touched nothing. Locally 0 — a flake there is signal worth chasing.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
});
