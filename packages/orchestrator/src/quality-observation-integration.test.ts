import { describe, expect, it } from 'vitest';
import {
  WorkflowDefinitionSchema,
  type QualityObservation,
  type RouterDecisionLogEntry,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import type {
  IdGenerator,
  QualityObservationRepository,
  RouterDecisionLogRepository,
} from '@agent-foundry/domain';
import { completeRun, makeHarness, stubSystemPrompts as systemPrompts } from './testing/harness.js';
import { QualityObservationService } from './quality-observation-service.js';

const workflow: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'quality-observation-v1',
  name: 'Quality observation fixture',
  description: 'A routed implementation reviewed by a blind reviewer.',
  stack: 'node',
  nodes: [
    {
      id: 'quality',
      type: 'quality-loop',
      title: 'Review implementation',
      setup: {
        id: 'implement',
        type: 'agent',
        role: 'developer',
        taskKind: 'implementation',
        title: 'Implement',
        instructions: 'Implement the feature.',
        outputArtifact: 'implementation',
        mutatesWorkspace: true,
      },
      check: {
        id: 'review',
        type: 'agent',
        role: 'code-reviewer',
        taskKind: 'code-review',
        title: 'Review',
        instructions: 'Review the implementation.',
        inputArtifacts: ['implementation'],
        outputArtifact: 'review',
      },
      repair: {
        id: 'repair',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair',
        instructions: 'Repair the implementation.',
        inputArtifacts: ['implementation', 'review'],
        outputArtifact: 'implementation',
      },
      approval: { artifact: 'review', path: 'status', equals: 'completed' },
    },
  ],
});

const workflowWithoutSetup: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'quality-observation-without-setup-v1',
  name: 'Quality observation without setup fixture',
  description: 'A routed implementation reviewed by a blind reviewer.',
  stack: 'node',
  nodes: [
    {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement the feature.',
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
    },
    {
      id: 'quality',
      type: 'quality-loop',
      title: 'Review implementation',
      check: {
        id: 'review',
        type: 'agent',
        role: 'code-reviewer',
        taskKind: 'code-review',
        title: 'Review',
        instructions: 'Review the implementation.',
        inputArtifacts: ['implementation'],
        outputArtifact: 'review',
      },
      repair: {
        id: 'repair',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair',
        instructions: 'Repair the implementation.',
        inputArtifacts: ['implementation', 'review'],
        outputArtifact: 'implementation',
      },
      approval: { artifact: 'review', path: 'status', equals: 'completed' },
    },
  ],
});

class MemoryQualityObservations implements QualityObservationRepository {
  readonly values: QualityObservation[] = [];
  async record(observation: QualityObservation): Promise<void> {
    this.values.push(observation);
  }
  async list(): Promise<QualityObservation[]> {
    return this.values;
  }
}

class MemoryRouterDecisionLog implements RouterDecisionLogRepository {
  readonly values: RouterDecisionLogEntry[] = [];
  async append(entry: RouterDecisionLogEntry): Promise<void> {
    this.values.push(entry);
  }
  async list(): Promise<RouterDecisionLogEntry[]> {
    return this.values;
  }
}

describe('WorkflowOrchestrator quality observations', () => {
  it('records an approved blind review for the setup output', async () => {
    const observations = new MemoryQualityObservations();
    let sequence = 0;
    const ids: IdGenerator = { next: () => `quality-${String(++sequence)}` };
    const harness = makeHarness({}, undefined, {
      workflow,
      qualityObservationService: new QualityObservationService(
        observations,
        {
          now: () => new Date('2026-07-18T12:00:00.000Z'),
        },
        ids,
      ),
    });

    await completeRun(harness);

    expect(observations.values).toMatchObject([
      {
        source: 'blind-review',
        blind: true,
        score: 1,
        subject: { artifact: { name: 'implementation', revision: 1 } },
      },
    ]);
  });

  it('records an approved blind review for a routed input when no setup step exists', async () => {
    const observations = new MemoryQualityObservations();
    let sequence = 0;
    const ids: IdGenerator = { next: () => `quality-${String(++sequence)}` };
    const harness = makeHarness({}, undefined, {
      workflow: workflowWithoutSetup,
      qualityObservationService: new QualityObservationService(
        observations,
        { now: () => new Date('2026-07-18T12:00:00.000Z') },
        ids,
      ),
    });

    await completeRun(harness);

    expect(observations.values).toMatchObject([
      {
        source: 'blind-review',
        blind: true,
        score: 1,
        subject: { artifact: { name: 'implementation', revision: 1 } },
      },
    ]);
  });

  it('appends a router decision log entry for the approved iteration', async () => {
    const decisionLog = new MemoryRouterDecisionLog();
    const harness = makeHarness({}, undefined, { workflow, decisionLog, systemPrompts });

    await completeRun(harness);

    expect(decisionLog.values).toMatchObject([
      {
        approved: true,
        firstPass: true,
        repairs: 0,
        workflowId: workflow.id,
        harnessVersion: harness.harnessVersion.value,
        systemPromptVersion: 'system-prompts-1',
        taskKind: 'implementation',
        modelId: expect.any(String),
      },
    ]);
  });
});
