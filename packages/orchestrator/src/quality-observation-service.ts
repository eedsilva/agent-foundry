import {
  QualityObservationSchema,
  type ArtifactReference,
  type QualityObservation,
  type QualityObservationInput,
  type QualitySubject,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import type { Clock, IdGenerator, QualityObservationRepository } from '@agent-foundry/domain';

export class QualityObservationService {
  constructor(
    private readonly observations: QualityObservationRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  recordDeterministic(
    producer: StoredArtifact,
    verification: StoredArtifact,
    approved: boolean,
  ): Promise<QualityObservation | null> {
    return this.record({
      source: 'deterministic',
      producer,
      evaluator: { kind: 'deterministic', id: 'workspace-verifier' },
      rubric: 'workspace-verifier',
      score: approved ? 1 : 0,
      evidence: [
        {
          kind: 'verification-report',
          artifact: artifactReference(verification),
          summary: approved ? 'Verification approved.' : 'Verification rejected.',
        },
      ],
    });
  }

  recordBlindReview(
    producer: StoredArtifact,
    review: StoredArtifact,
    approved: boolean,
  ): Promise<QualityObservation | null> {
    const reviewRoute = review.metadata.routeDecision;
    if (!reviewRoute) return Promise.resolve(null);
    const reviewer = reviewRoute.executed ?? reviewRoute.selected;
    return this.record({
      source: 'blind-review',
      producer,
      evaluator: { kind: 'llm', id: reviewer.model.id },
      rubric: 'workflow-review',
      score: approved ? 1 : 0,
      evidence: [
        {
          kind: 'review-artifact',
          artifact: artifactReference(review),
          summary: approved ? 'Blind review approved.' : 'Blind review requested changes.',
        },
      ],
    });
  }

  recordDelayed(
    producer: StoredArtifact,
    input: QualityObservationInput,
  ): Promise<QualityObservation | null> {
    return this.record({
      source: input.source,
      producer,
      evaluator: input.evaluator,
      rubric: input.rubric,
      score: input.score,
      evidence: input.evidence,
    });
  }

  private async record(input: {
    source: QualityObservation['source'];
    producer: StoredArtifact;
    evaluator: QualityObservation['evaluator'];
    rubric: string;
    score: number;
    evidence: QualityObservation['evidence'];
  }): Promise<QualityObservation | null> {
    const subject = qualitySubject(input.producer);
    if (!subject) return null;
    const observation = QualityObservationSchema.parse({
      id: this.ids.next(),
      source: input.source,
      subject,
      evaluator: input.evaluator,
      blind: input.source === 'blind-review',
      rubric: input.rubric,
      score: input.score,
      evidence: input.evidence,
      observedAt: this.clock.now().toISOString(),
    });
    await this.observations.record(observation);
    return observation;
  }
}

function qualitySubject(artifact: StoredArtifact): QualitySubject | null {
  const route = artifact.metadata.routeDecision;
  if (!route) return null;
  const producer = route.executed ?? route.selected;
  return {
    modelId: producer.model.id,
    taskKind: route.profile.taskKind,
    role: route.profile.role,
    taxonomyVersion: route.profile.taxonomyVersion,
    category: route.profile.category,
    artifact: artifactReference(artifact),
  };
}

function artifactReference(artifact: StoredArtifact): ArtifactReference {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}
