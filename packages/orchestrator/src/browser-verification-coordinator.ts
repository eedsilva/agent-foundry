import { isDeepStrictEqual } from 'node:util';
import {
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  PreviewSessionReferenceSchema,
  type ArtifactReference,
  type BrowserVerificationReport,
  type PreviewSessionReference,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import type { BrowserVerifier } from '@agent-foundry/domain';
import type { PreviewService } from './preview-service.js';

export interface BrowserVerificationInput {
  projectId: string;
  workspacePath: string;
  runId: string;
  plan: StoredArtifact;
  allowedOrigins: string[];
}

export class BrowserVerificationCoordinator {
  constructor(
    private readonly previews: Pick<PreviewService, 'start' | 'stop'>,
    private readonly verifier: BrowserVerifier,
  ) {}

  async verify(
    input: BrowserVerificationInput,
    signal: AbortSignal,
    onSessionStarted?: (sessionId: string) => Promise<void>,
  ): Promise<BrowserVerificationReport> {
    const started = await this.previews.start({
      workspaceRef: { projectId: input.projectId, workspacePath: input.workspacePath },
      runId: input.runId,
    });
    const session = PreviewSessionReferenceSchema.parse({
      sessionId: started.session.id,
      status: started.session.status,
      ...(started.url ? { url: started.url } : {}),
      evidence: { screenshots: [] },
    });
    const publicSession = PreviewSessionReferenceSchema.parse({
      ...session,
      ...(session.url ? { url: publicUrl(session.url) } : {}),
    });
    const planArtifact = artifactReference(input.plan);
    let verificationFailed = false;
    let verificationError: unknown;

    try {
      await onSessionStarted?.(started.session.id);
      const parsed = BrowserTestPlanArtifactSchema.safeParse(input.plan.content);
      if (!parsed.success) {
        return BrowserVerificationReportSchema.parse({
          schemaVersion: '1',
          approved: false,
          summary: 'Browser test plan validation failed.',
          planArtifact,
          previewSession: publicSession,
          planValidationError: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
            .join('; '),
          steps: [],
        });
      }

      return validateBrowserVerificationReportBinding(
        await this.verifier.verify(
          {
            planArtifact,
            planContent: input.plan.content,
            session,
            allowedOrigins: input.allowedOrigins,
          },
          signal,
        ),
        {
          planArtifact,
          planContent: input.plan.content,
          previewSession: publicSession,
        },
      );
    } catch (error) {
      verificationFailed = true;
      verificationError = error;
      throw error;
    } finally {
      try {
        await this.previews.stop(started.session.id);
      } catch (stopError) {
        if (verificationFailed) {
          throw new AggregateError(
            [verificationError, stopError],
            'Browser verification and preview cleanup both failed',
          );
        }
        throw stopError;
      }
    }
  }
}

export function validateBrowserVerificationReportBinding(
  report: unknown,
  expected: {
    planArtifact: ArtifactReference;
    planContent: unknown;
    previewSession?: PreviewSessionReference;
    previewSessionId?: string;
  },
): BrowserVerificationReport {
  const parsedReport = BrowserVerificationReportSchema.parse(report);
  const parsedPlan = BrowserTestPlanArtifactSchema.safeParse(expected.planContent);
  const expectedSteps = parsedPlan.success
    ? parsedPlan.data.data.steps.map(({ id: stepId, title }) => ({ stepId, title }))
    : [];
  const actualSteps = parsedReport.steps.map(({ stepId, title }) => ({ stepId, title }));
  if (
    !isDeepStrictEqual(parsedReport.planArtifact, expected.planArtifact) ||
    (expected.previewSession &&
      !isDeepStrictEqual(parsedReport.previewSession, expected.previewSession)) ||
    (expected.previewSessionId &&
      parsedReport.previewSession.sessionId !== expected.previewSessionId) ||
    !isDeepStrictEqual(actualSteps, expectedSteps)
  ) {
    throw new Error('Browser verification report is not bound to the requested plan and session.');
  }
  return parsedReport;
}

function artifactReference(artifact: StoredArtifact): ArtifactReference {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

function publicUrl(value: string): string {
  const url = new URL(value);
  url.search = '';
  return url.toString();
}
