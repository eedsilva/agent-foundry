import type { CanaryScenario } from '@agent-foundry/contracts';

export interface ProviderCanaryFixture {
  scenario: CanaryScenario;
  prompt: string;
  files: Readonly<Record<string, string>>;
  allowedFiles: readonly string[];
  mutatesWorkspace: boolean;
}

const packageJson = `${JSON.stringify(
  {
    name: 'agent-foundry-provider-canary',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  },
  null,
  2,
)}\n`;

export const PROVIDER_CANARY_FIXTURES: Readonly<Record<CanaryScenario, ProviderCanaryFixture>> = {
  planning: {
    scenario: 'planning',
    mutatesWorkspace: false,
    allowedFiles: [],
    files: {
      'package.json': packageJson,
      'README.md': '# Greeting CLI\n\nAdd a small greeting function in a future implementation.\n',
      'test/smoke.test.js':
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('fixture is healthy', () => assert.equal(1 + 1, 2));\n",
    },
    prompt:
      'Inspect this dependency-free repository and describe a concise implementation plan for a greeting function. Do not create, edit, delete, or rename any file.',
  },
  greenfield: {
    scenario: 'greenfield',
    mutatesWorkspace: true,
    allowedFiles: ['src/greeting.js'],
    files: {
      'package.json': packageJson,
      'README.md':
        '# Greeting function\n\nImplement src/greeting.js. Do not change any other project file.\n',
      'src/.gitkeep': '',
      'test/greeting.test.js':
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greeting } from '../src/greeting.js';\n\ntest('greets a supplied name', () => {\n  assert.equal(greeting('Ada'), 'Hello, Ada!');\n});\n",
    },
    prompt:
      'Implement src/greeting.js so the existing node:test suite passes. Only src/greeting.js may change.',
  },
  repair: {
    scenario: 'repair',
    mutatesWorkspace: true,
    allowedFiles: ['sum.js'],
    files: {
      'package.json': packageJson,
      'README.md': '# Sum repair\n\nRepair the existing sum implementation.\n',
      'sum.js': 'export function sum(left, right) { return left - right; }\n',
      'test/sum.test.js':
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../sum.js';\n\ntest('adds two numbers', () => {\n  assert.equal(sum(7, 5), 12);\n});\n",
    },
    prompt: 'Repair sum.js so the existing node:test suite passes. Only sum.js may change.',
  },
};
