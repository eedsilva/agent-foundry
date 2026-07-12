import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@agent-foundry/contracts': `${root}packages/contracts/src/index.ts`,
      '@agent-foundry/domain': `${root}packages/domain/src/index.ts`,
      '@agent-foundry/persistence': `${root}packages/persistence/src/index.ts`,
      '@agent-foundry/harness': `${root}packages/harness/src/index.ts`,
      '@agent-foundry/model-router': `${root}packages/model-router/src/index.ts`,
      '@agent-foundry/executors': `${root}packages/executors/src/index.ts`,
      '@agent-foundry/orchestrator': `${root}packages/orchestrator/src/index.ts`,
      '@agent-foundry/composition': `${root}packages/composition/src/index.ts`,
    },
  },
});
