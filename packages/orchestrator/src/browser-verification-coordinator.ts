import {
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  PreviewSessionReferenceSchema,
  type ArtifactReference,
  type BrowserVerificationReport,
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
    const planArtifact = artifactReference(input.plan);

    try {
      await onSessionStarted?.(started.session.id);
      const parsed = BrowserTestPlanArtifactSchema.safeParse(input.plan.content);
      if (!parsed.success) {
        return BrowserVerificationReportSchema.parse({
          schemaVersion: '1',
          approved: false,
          summary: 'Browser test plan validation failed.',
          planArtifact,
          previewSession: {
            ...session,
            ...(session.url ? { url: publicUrl(session.url) } : {}),
          },
          planValidationError: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
            .join('; '),
          steps: [],
        });
      }

      return await this.verifier.verify(
        {
          planArtifact,
          planContent: input.plan.content,
          session,
          allowedOrigins: input.allowedOrigins,
        },
        signal,
      );
    } finally {
      await this.previews.stop(started.session.id);
    }
  }
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
