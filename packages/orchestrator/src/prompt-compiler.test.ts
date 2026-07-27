import { describe, expect, it } from 'vitest';
import type { AgentStep, ProjectEvent, StoredArtifact } from '@agent-foundry/contracts';
import { compileRequestMarkdown } from './prompt-compiler.js';

describe('compileRequestMarkdown feedback provenance', () => {
  it('includes preview failure events for repair context without an artifact reference', () => {
    const failureEvent: ProjectEvent = {
      id: 'event-1',
      projectId: 'project-1',
      type: 'preview.failed',
      createdAt: '2026-07-18T12:00:00.000Z',
      message: 'Dev server exited.',
      data: {
        diagnostic: {
          command: { command: 'pnpm', args: ['dev'] },
          exitCode: 1,
          output: { stdout: '', stderr: 'Cannot find module' },
        },
      },
    };
    const output = compileRequestMarkdown({
      projectId: 'project-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      workflowId: 'workflow-1',
      stack: 'node',
      step: {
        id: 'repair',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair',
        instructions: 'Repair.',
        inputArtifacts: [],
        secretRefs: [],
        outputArtifact: 'repair',
        mutatesWorkspace: true,
        harnessTags: [],
        profile: {},
        maxAttempts: 1,
      },
      harness: { version: '1', files: [], combined: '' },
      artifacts: [],
      previewFailureEvents: [failureEvent],
      workspacePath: '/tmp/workspace',
    });

    expect(output).toContain('## Preview failure diagnostics');
    expect(output).toContain('Cannot find module');
    expect(output).toContain('"exitCode": 1');
  });

  it('states the explicit tool policy', () => {
    const step: AgentStep = {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan.',
      inputArtifacts: [],
      secretRefs: [],
      outputArtifact: 'plan',
      mutatesWorkspace: false,
      maxAttempts: 1,
      harnessTags: [],
      profile: {},
    };
    const output = compileRequestMarkdown({
      projectId: 'project-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      workflowId: 'workflow-1',
      stack: 'node',
      step,
      harness: { version: '1', files: [], combined: '' },
      artifacts: [],
      workspacePath: '/tmp/workspace',
    });
    expect(output).toContain('Tool policy: read-only');
  });

  it('renders the exact feedback artifact name, revision, and SHA-256', () => {
    const sha256 = 'a'.repeat(64);
    const artifact: StoredArtifact = {
      metadata: {
        projectId: 'project-1',
        name: 'repair-notes',
        revision: 2,
        contentType: 'application/json',
        createdAt: '2026-07-14T12:00:00.000Z',
        createdBy: 'approval-gate:gate',
        kind: 'feedback',
        actor: { kind: 'user', id: 'ed' },
        sourceDecisionId: 'decision-1',
        sha256,
      },
      content: { schemaVersion: '1', note: 'add tests' },
    };
    const step: AgentStep = {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement.',
      inputArtifacts: [],
      secretRefs: [],
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
      maxAttempts: 1,
      harnessTags: [],
      profile: {},
    };
    const output = compileRequestMarkdown({
      projectId: 'project-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      workflowId: 'workflow-1',
      stack: 'node',
      step,
      harness: { version: '1', files: [], combined: '' },
      artifacts: [artifact],
      workspacePath: '/tmp/workspace',
    });

    expect(output).toContain('### repair-notes · revision 2');
    expect(output).toContain(`SHA-256: ${sha256}`);
  });

  it('hides producer metadata from reviewer requests while keeping artifact content', () => {
    const artifact: StoredArtifact = {
      metadata: {
        projectId: 'project-1',
        name: 'implementation',
        revision: 1,
        contentType: 'application/json',
        createdAt: '2026-07-18T12:00:00.000Z',
        createdBy: 'developer:codex/gpt-5',
        sha256: 'a'.repeat(64),
      },
      content: { summary: 'Implementation output' },
    };
    const step: AgentStep = {
      id: 'review',
      type: 'agent',
      role: 'code-reviewer',
      taskKind: 'code-review',
      title: 'Review',
      instructions: 'Review the implementation.',
      inputArtifacts: ['implementation'],
      secretRefs: [],
      outputArtifact: 'review',
      mutatesWorkspace: false,
      maxAttempts: 1,
      harnessTags: [],
      profile: {},
    };

    const output = compileRequestMarkdown({
      projectId: 'project-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      workflowId: 'workflow-1',
      stack: 'node',
      step,
      harness: { version: '1', files: [], combined: '' },
      artifacts: [artifact],
      workspacePath: '/tmp/workspace',
    });

    expect(output).toContain('### Input artifact · revision 1');
    expect(output).toContain('Implementation output');
    expect(output).not.toContain('developer:codex/gpt-5');
    expect(output).not.toContain('Created by:');
  });
});
