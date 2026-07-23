import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import {
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  PreviewSessionReferenceSchema,
  type ArtifactMetadata,
  type ArtifactReference,
  type BrowserEvidencePolicy,
  type BrowserScreenshotEvidence,
  type BrowserVerificationReport,
  type PreviewSessionReference,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import {
  ArtifactTooLargeError,
  type ArtifactBlobPutInput,
  type ArtifactStore,
  type BrowserVerificationEvidence,
  type BrowserVerifier,
} from '@agent-foundry/domain';
import type { PreviewService } from './preview-service.js';

export interface BrowserVerificationInput {
  projectId: string;
  workspacePath: string;
  runId: string;
  plan: StoredArtifact;
  allowedOrigins: string[];
  evidencePolicy: BrowserEvidencePolicy;
}

export interface BrowserEvidenceLimits {
  maxScreenshotBytes: number;
  maxTraceBytes: number;
  maxVideoBytes: number;
  retentionSeconds: number;
}

export class BrowserVerificationCoordinator {
  constructor(
    private readonly previews: Pick<PreviewService, 'start' | 'stop'>,
    private readonly verifier: BrowserVerifier,
    private readonly artifacts: Pick<ArtifactStore, 'putBlob'>,
    private readonly limits: BrowserEvidenceLimits,
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

      const { report: verifierReport, evidence } = await this.verifier.verify(
        {
          planArtifact,
          planContent: input.plan.content,
          session,
          allowedOrigins: input.allowedOrigins,
          evidencePolicy: input.evidencePolicy,
        },
        signal,
      );
      const validated = validateBrowserVerificationReportBinding(verifierReport, {
        planArtifact,
        planContent: input.plan.content,
        previewSession: publicSession,
      });
      return await this.attachEvidence(validated, evidence, input);
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

  private async attachEvidence(
    report: BrowserVerificationReport,
    evidence: BrowserVerificationEvidence,
    input: BrowserVerificationInput,
  ): Promise<BrowserVerificationReport> {
    if (
      evidence.screenshots.length === 0 &&
      !evidence.trace &&
      !evidence.video &&
      !evidence.networkEvents?.length
    )
      return report;
    const sessionId = report.previewSession.sessionId;

    const [screenshots, trace, video, networkPolicy] = await Promise.all([
      Promise.all(
        evidence.screenshots.map(async (shot) => {
          const ref = await this.putEvidenceRef(
            input,
            `browser-screenshot-${sessionId}-${shot.stepId}`,
            'image/png',
            this.limits.maxScreenshotBytes,
            shot.buffer,
          );
          return ref
            ? { ...ref, stepId: shot.stepId, url: shot.url, viewport: shot.viewport }
            : undefined;
        }),
      ).then((refs) => refs.filter((ref): ref is BrowserScreenshotEvidence => ref !== undefined)),
      evidence.trace
        ? this.putEvidenceRef(
            input,
            `browser-trace-${sessionId}`,
            'application/zip',
            this.limits.maxTraceBytes,
            evidence.trace,
          )
        : Promise.resolve(undefined),
      evidence.video
        ? this.putEvidenceRef(
            input,
            `browser-video-${sessionId}`,
            'video/webm',
            this.limits.maxVideoBytes,
            evidence.video,
          )
        : Promise.resolve(undefined),
      evidence.networkEvents?.length
        ? this.putEvidenceRef(
            input,
            `browser-network-policy-${sessionId}`,
            'application/json',
            1_000_000,
            Buffer.from(
              JSON.stringify({ schemaVersion: '1', events: evidence.networkEvents }),
              'utf8',
            ),
          )
        : Promise.resolve(undefined),
    ]);

    return BrowserVerificationReportSchema.parse({
      ...report,
      previewSession: {
        ...report.previewSession,
        evidence: {
          ...report.previewSession.evidence,
          screenshots,
          ...(trace ? { trace } : {}),
          ...(video ? { video } : {}),
          ...(networkPolicy ? { networkPolicy } : {}),
        },
      },
    });
  }

  private async putEvidenceRef(
    input: BrowserVerificationInput,
    name: string,
    contentType: string,
    maxBytes: number,
    buffer: Buffer,
  ): Promise<ArtifactReference | undefined> {
    const metadata = await this.putBlobOrSkip(
      {
        projectId: input.projectId,
        name,
        contentType,
        createdBy: 'browser-verifier',
        maxBytes,
        runId: input.runId,
        retentionSeconds: this.limits.retentionSeconds,
      },
      Readable.from(buffer),
    );
    return metadata
      ? {
          name: metadata.name,
          revision: metadata.revision,
          sha256: metadata.sha256,
          sizeBytes: metadata.sizeBytes,
        }
      : undefined;
  }

  private async putBlobOrSkip(
    input: ArtifactBlobPutInput,
    source: Readable,
  ): Promise<ArtifactMetadata | undefined> {
    try {
      return await this.artifacts.putBlob(input, source);
    } catch (error) {
      if (error instanceof ArtifactTooLargeError) return undefined;
      throw error;
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
