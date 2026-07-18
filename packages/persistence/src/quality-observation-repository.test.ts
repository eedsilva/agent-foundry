import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QualityObservation, QualitySubject } from '@agent-foundry/contracts';
import * as persistence from './index.js';
import { FileQualityObservationRepository } from './quality-observation-repository.js';

const subject: QualitySubject = {
  modelId: 'model-1',
  taskKind: 'implementation',
  role: 'developer',
  taxonomyVersion: '2',
  category: 'implementation/backend',
  artifact: { name: 'implementation', revision: 1, sha256: 'a'.repeat(64) },
};

function observation(overrides: Partial<QualityObservation> = {}): QualityObservation {
  return {
    id: 'quality-1',
    source: 'deterministic',
    subject,
    evaluator: { kind: 'deterministic', id: 'workspace-verifier' },
    blind: false,
    rubric: 'workspace-verifier',
    score: 1,
    evidence: [{ kind: 'verification-report', summary: 'All checks passed.' }],
    observedAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

describe('FileQualityObservationRepository', () => {
  let dataDir: string;
  let repository: FileQualityObservationRepository;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-quality-'));
    repository = new FileQualityObservationRepository(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('exports the append-only repository', () => {
    expect('FileQualityObservationRepository' in persistence).toBe(true);
  });

  it('appends each id once and lists only the exact producing artifact', async () => {
    const otherSubject: QualitySubject = {
      ...subject,
      artifact: { ...subject.artifact, revision: 2, sha256: 'c'.repeat(64) },
    };

    await repository.record(observation());
    await repository.record(observation());
    await repository.record(
      observation({ id: 'quality-2', subject: otherSubject, observedAt: '2026-07-18T12:01:00.000Z' }),
    );

    await expect(repository.list(subject)).resolves.toEqual([observation()]);
  });
});
