import { describe, expect, it } from 'vitest';
import type { AgentStep, StoredArtifact } from '@agent-foundry/contracts';
import type { HarnessSelection } from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';

const harness: HarnessSelection = { version: '1', files: [], combined: '' };
const step: AgentStep = {
  id: 'implement',
  type: 'agent',
  role: 'developer',
  taskKind: 'implementation',
  title: 'Implement',
  instructions: 'Implement the requested change.',
  inputArtifacts: [],
  outputArtifact: 'implementation',
  mutatesWorkspace: true,
  maxAttempts: 1,
  harnessTags: [],
  profile: {},
};

function artifact(content: unknown): StoredArtifact {
  return {
    metadata: {
      projectId: 'project-1',
      name: 'context',
      revision: 1,
      contentType: 'application/json',
      createdAt: '2026-07-18T12:00:00.000Z',
      createdBy: 'test',
      actor: { kind: 'system', id: 'test' },
      sha256: 'a'.repeat(64),
    },
    content,
  };
}

describe('buildTaskProfile taxonomy', () => {
  it('preserves a declared workflow category', () => {
    expect(
      buildTaskProfile({
        step: { ...step, profile: { category: 'implementation/frontend' } },
        harness,
        artifacts: [],
      }),
    ).toMatchObject({
      taxonomyVersion: '2',
      category: 'implementation/frontend',
    });
  });

  it('classifies implementation from instruction features', () => {
    expect(
      buildTaskProfile({
        step: { ...step, instructions: 'Add a PostgreSQL migration and Playwright tests' },
        harness,
        artifacts: [],
      }),
    ).toMatchObject({
      taxonomyVersion: '2',
      category: 'implementation/database',
      features: ['database', 'tests'],
    });
  });

  it('classifies repairs by their first domain feature', () => {
    expect(
      buildTaskProfile({
        step: { ...step, taskKind: 'repair', instructions: 'Repair the webhook.' },
        harness,
        artifacts: [],
      }),
    ).toMatchObject({ category: 'repair/integration' });
  });

  it('falls back to a general implementation category', () => {
    expect(buildTaskProfile({ step, harness, artifacts: [] })).toMatchObject({
      category: 'implementation/general',
    });
  });

  it('extracts every matching feature from instructions, harness, artifacts, and tags', () => {
    expect(
      buildTaskProfile({
        step: { ...step, instructions: 'Build a backend endpoint.', harnessTags: ['database'] },
        harness: { ...harness, combined: 'Update the React component.' },
        artifacts: [artifact({ integration: 'provider webhook tests' })],
      }).features,
    ).toEqual(['database', 'frontend', 'backend', 'integration', 'tests']);
  });
});
