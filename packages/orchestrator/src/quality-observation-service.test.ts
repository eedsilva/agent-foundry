import { describe, expect, it } from 'vitest';
import {
  RouteDecisionSchema,
  type QualityObservation,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import type { Clock, IdGenerator, QualityObservationRepository } from '@agent-foundry/domain';
import * as orchestrator from './index.js';
import { QualityObservationService } from './quality-observation-service.js';

const routeDecision = RouteDecisionSchema.parse({
  routeId: 'route-1',
  createdAt: '2026-07-18T12:00:00.000Z',
  profile: {
    role: 'developer',
    taskKind: 'implementation',
    taxonomyVersion: '2',
    category: 'implementation/backend',
    features: ['backend'],
    complexity: 3,
    risk: 3,
    estimatedContextTokens: 1_000,
    estimatedOutputTokens: 500,
    mutatesWorkspace: true,
    priorities: { quality: 0.5, speed: 0.2, cost: 0.1, reliability: 0.2 },
    preferredTags: [],
  },
  selected: {
    model: {
      id: 'producer',
      provider: 'codex',
      model: 'gpt-5',
      maxContextTokens: 100_000,
      capabilities: {
        planning: 0.5,
        architecture: 0.5,
        coding: 0.5,
        review: 0.5,
        repair: 0.5,
        structuredOutput: 0.5,
        speed: 0.5,
        costEfficiency: 0.5,
        reliability: 0.5,
      },
    },
    score: {
      capability: 0.5,
      context: 0.5,
      speed: 0.5,
      cost: 0.5,
      reliability: 0.5,
      historical: 0.5,
      tagAffinity: 0,
      estimatedCostUsd: null,
      total: 0.5,
    },
  },
  fallbacks: [],
  rejected: [],
});

function artifact(
  name: string,
  route = routeDecision,
  createdBy = 'developer:codex/gpt-5',
): StoredArtifact {
  return {
    metadata: {
      projectId: 'project-1',
      name,
      revision: 1,
      contentType: 'application/json',
      createdAt: '2026-07-18T12:00:00.000Z',
      createdBy,
      sha256: name === 'implementation' ? 'a'.repeat(64) : 'b'.repeat(64),
      routeDecision: route,
    },
    content: { schemaVersion: '1', approved: true, summary: `${name} complete` },
  };
}

class MemoryQualityObservations implements QualityObservationRepository {
  readonly values: QualityObservation[] = [];
  async record(observation: QualityObservation): Promise<void> {
    this.values.push(observation);
  }
  async list(): Promise<QualityObservation[]> {
    return this.values;
  }
}

const clock: Clock = { now: () => new Date('2026-07-18T12:00:00.000Z') };
let sequence = 0;
const ids: IdGenerator = { next: () => `quality-${String(++sequence)}` };

describe('QualityObservationService', () => {
  it('exports the service that records workflow quality', () => {
    expect('QualityObservationService' in orchestrator).toBe(true);
  });

  it('records verifier, blind reviewer, and human edit observations against the same producer artifact', async () => {
    const repository = new MemoryQualityObservations();
    const service = new QualityObservationService(repository, clock, ids);
    const producer = artifact('implementation');
    const producerReference = {
      name: producer.metadata.name,
      revision: producer.metadata.revision,
      sha256: producer.metadata.sha256,
    };

    await service.recordDeterministic(producer, artifact('verification-report'), true);
    await service.recordBlindReview(
      producer,
      artifact('review', routeDecision, 'code-reviewer:claude/sonnet'),
      false,
    );
    await service.recordDelayed(producer, {
      source: 'human-edit',
      artifact: producerReference,
      evaluator: { kind: 'human', id: 'ed' },
      rubric: 'post-review-edit',
      score: 0.8,
      evidence: [{ kind: 'human-edit', summary: 'Human accepted the implementation.' }],
    });

    expect(repository.values).toMatchObject([
      {
        source: 'deterministic',
        blind: false,
        evaluator: { kind: 'deterministic', id: 'workspace-verifier' },
        subject: { artifact: producerReference },
      },
      {
        source: 'blind-review',
        blind: true,
        evaluator: { kind: 'llm', id: 'producer' },
        subject: { artifact: producerReference },
      },
      {
        source: 'human-edit',
        blind: false,
        evaluator: { kind: 'human', id: 'ed' },
        subject: { artifact: producerReference },
      },
    ]);
  });
});
