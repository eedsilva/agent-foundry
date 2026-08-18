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
    expect(requestFor(readOnlyStep())).toContain('Tool policy: read-only');
  });

  it('tells a mutating agent to defer sandbox-denied checks to the host verifier, not answer blocked (#373)', () => {
    const output = requestFor(mutatingStep());

    expect(output).toContain('record it in `nextActions` as a deferred host-owned check');
    expect(output).toContain(
      'Answer `blocked` only when you could not produce the deliverable itself',
    );
  });

  it('keeps blocked a valid answer for read-only steps by omitting the deferred-check rule (#373)', () => {
    expect(requestFor(readOnlyStep())).not.toContain(
      'record it in `nextActions` as a deferred host-owned check',
    );
  });

  // The rule list is numbered by array index, so a conditionally inserted rule
  // must not leave a gap or a repeat behind it (#373).
  it('renders non-negotiable rules with contiguous numbering starting at 1 (#373)', () => {
    for (const step of [mutatingStep(), readOnlyStep()]) {
      const rulesSection = requestFor(step)
        .split('## Non-negotiable execution rules')[1]
        ?.split('## Versioned harness')[0];
      const numbers = [...(rulesSection?.matchAll(/^(\d+)\. /gm) ?? [])].map((match) =>
        Number(match[1]),
      );
      expect(numbers.length).toBeGreaterThan(0);
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    }
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

describe('browser evidence files (#357)', () => {
  const repairStep: AgentStep = {
    id: 'repair-task-browser.T1',
    type: 'agent',
    role: 'fixer',
    taskKind: 'repair',
    title: 'Repair',
    instructions: 'Fix the failing assertion.',
    inputArtifacts: [],
    secretRefs: [],
    mutatesWorkspace: true,
    harnessTags: [],
    profile: {},
    maxAttempts: 2,
    outputArtifact: 'verification.fix',
  };
  const base = {
    projectId: 'project-1',
    runId: 'run-1',
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    workflowId: 'workflow-1',
    stack: 'node',
    step: repairStep,
    harness: { version: '1', combined: '', files: [] },
    artifacts: [],
    workspacePath: '/workspace',
  };

  it('renders openable paths for materialized steps and marks report refs unreachable', () => {
    const markdown = compileRequestMarkdown({ ...base, browserEvidenceStepIds: ['open-root'] });
    expect(markdown).toContain('## Browser evidence files');
    expect(markdown).toContain(
      '- open-root: .orchestrator/runs/run-1/steps/step-1/attempts/attempt-1/inputs/browser-evidence/open-root.png',
    );
    expect(markdown).toContain('storage identifiers you cannot open');
  });

  it('states plainly when no evidence file is available instead of claiming refs', () => {
    const markdown = compileRequestMarkdown(base);
    expect(markdown).toContain('No browser evidence files were materialized');
    expect(markdown).toContain('only the step errors are available');
  });
});

function mutatingStep(): AgentStep {
  return {
    id: 'implement',
    type: 'agent',
    role: 'developer',
    taskKind: 'implementation',
    title: 'Implement',
    instructions: 'Implement.',
    inputArtifacts: [],
    secretRefs: [],
    outputArtifact: 'implementation.report',
    mutatesWorkspace: true,
    maxAttempts: 1,
    harnessTags: [],
    profile: {},
  };
}

function readOnlyStep(): AgentStep {
  return {
    ...mutatingStep(),
    id: 'plan',
    role: 'planner',
    taskKind: 'planning',
    title: 'Plan',
    instructions: 'Plan.',
    outputArtifact: 'plan',
    mutatesWorkspace: false,
  };
}

function requestFor(step: AgentStep): string {
  return compileRequestMarkdown({
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
}
