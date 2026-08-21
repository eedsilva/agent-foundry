import { describe, expect, it } from 'vitest';
import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionAgentRequestSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  ExecutionWorkspaceSnapshotSchema,
  WorkflowDefinitionSchema,
} from './index.js';

const AGENT_REQUEST = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'test-model',
  prompt: 'do the thing',
  mutatesWorkspace: true,
  timeoutMs: 60_000,
} as const;

const AGENT_RESULT = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  provider: 'codex',
  model: 'test-model',
  exitCode: 0,
  durationMs: 12,
  stdout: '{}',
  stderr: '',
  output: {
    schemaVersion: '1',
    status: 'completed',
    summary: 'done',
    data: {},
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  },
} as const;

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: 'attempt-1',
    agent: AGENT_REQUEST,
    workspace: { projectId: 'project-1', ref: 'deadbeef' },
    tools: [],
    limits: { timeoutMs: 60_000 },
    secrets: [],
    ...overrides,
  };
}

describe('ExecutionRequestSchema', () => {
  it('parses a fully populated request', () => {
    expect(ExecutionRequestSchema.parse(request())).toMatchObject({
      protocolVersion: '1',
      executionId: 'attempt-1',
    });
  });

  it('rejects an unknown protocol version', () => {
    expect(ExecutionRequestSchema.safeParse(request({ protocolVersion: '2' })).success).toBe(false);
  });

  it('never carries a local cwd — the field does not exist on the embedded agent request', () => {
    const parsed = ExecutionAgentRequestSchema.parse({ ...AGENT_REQUEST, cwd: '/Users/x/project' });
    expect(parsed).not.toHaveProperty('cwd');
  });

  it.each([undefined, 'low', 'medium'])(
    'rejects Luna effort %s before dispatch',
    (reasoningEffort) => {
      expect(
        ExecutionAgentRequestSchema.safeParse({
          ...AGENT_REQUEST,
          model: 'gpt-5.6-luna',
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }).success,
      ).toBe(false);
    },
  );

  it('accepts Luna only with explicit high effort', () => {
    expect(
      ExecutionAgentRequestSchema.safeParse({
        ...AGENT_REQUEST,
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
      }).success,
    ).toBe(true);
  });

  it('accepts declared refs but rejects a request carrying a value', () => {
    const agentNode = {
      id: 'agent-step',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Run agent',
      instructions: 'Run agent with declared secret refs.',
      outputArtifact: 'result',
      secretRefs: [{ name: 'GITHUB_TOKEN', ref: 'GITHUB_TOKEN' }],
    } as const;
    const definition = {
      schemaVersion: '1',
      id: 'secret-workflow',
      name: 'Secret workflow',
      description: 'Uses a declared secret reference.',
      stack: 'node',
      nodes: [agentNode],
    } as const;
    const workflow = WorkflowDefinitionSchema.parse(definition);

    expect(workflow.nodes[0]).toMatchObject({
      secretRefs: [{ name: 'GITHUB_TOKEN', ref: 'GITHUB_TOKEN' }],
    });
    const { secretRefs: _secretRefs, ...nodeWithoutSecretRefs } = agentNode;
    expect(
      WorkflowDefinitionSchema.parse({ ...definition, nodes: [nodeWithoutSecretRefs] }).nodes[0],
    ).toMatchObject({ secretRefs: [] });
    expect(
      WorkflowDefinitionSchema.safeParse({
        ...definition,
        nodes: [
          {
            ...agentNode,
            secretRefs: [{ name: 'GITHUB_TOKEN', ref: 'GITHUB_TOKEN', value: 'canary-secret' }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ExecutionRequestSchema.safeParse({
        ...request(),
        secrets: [{ name: 'GITHUB_TOKEN', ref: 'GITHUB_TOKEN', value: 'canary-secret' }],
      }).success,
    ).toBe(false);
  });
});

describe('ExecutionWorkspaceSnapshotSchema', () => {
  it('round-trips without a worktree label, unchanged', () => {
    const snapshot = ExecutionWorkspaceSnapshotSchema.parse({
      projectId: 'project-1',
      ref: 'deadbeef',
    });
    expect(snapshot).toEqual({ projectId: 'project-1', ref: 'deadbeef' });
  });

  it('round-trips with a worktree label', () => {
    const snapshot = ExecutionWorkspaceSnapshotSchema.parse({
      projectId: 'project-1',
      ref: 'deadbeef',
      worktree: 'task-a',
    });
    expect(snapshot.worktree).toBe('task-a');
  });

  it('rejects a worktree label that is not a safe path segment', () => {
    expect(
      ExecutionWorkspaceSnapshotSchema.safeParse({
        projectId: 'project-1',
        ref: 'deadbeef',
        worktree: '../escape',
      }).success,
    ).toBe(false);
  });
});

describe('ExecutionResultSchema', () => {
  it('parses a completed result carrying the agent result, no local paths', () => {
    const parsed = ExecutionResultSchema.parse({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      executionId: 'attempt-1',
      state: 'completed',
      agent: AGENT_RESULT,
    });
    expect(parsed.state).toBe('completed');
    expect(JSON.stringify(parsed)).not.toContain('/Users/');
  });

  it('parses a cancelled result with neither agent nor error', () => {
    expect(
      ExecutionResultSchema.parse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: 'attempt-1',
        state: 'cancelled',
      }).state,
    ).toBe('cancelled');
  });

  it('rejects a completed result missing the agent result', () => {
    expect(
      ExecutionResultSchema.safeParse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: 'attempt-1',
        state: 'completed',
      }).success,
    ).toBe(false);
  });

  it('rejects a failed result missing the error detail', () => {
    expect(
      ExecutionResultSchema.safeParse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: 'attempt-1',
        state: 'failed',
      }).success,
    ).toBe(false);
  });

  it('carries stdout/stderr/exitCode on failure without any filesystem path', () => {
    const parsed = ExecutionResultSchema.parse({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      executionId: 'attempt-1',
      state: 'failed',
      error: {
        message: 'CLI exited with a failure status',
        exitCode: 1,
        stdout: '',
        stderr: '429',
      },
    });
    expect(parsed.error?.exitCode).toBe(1);
  });
});
