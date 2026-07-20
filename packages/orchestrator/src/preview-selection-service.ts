import {
  ArtifactReferenceSchema,
  type PreviewSelectionRequest,
  type PreviewSelectionResult,
} from '@agent-foundry/contracts';
import {
  resolveWorkspaceRelativePath,
  type SelectionScreenshotCapturer,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { sha256 } from './idempotency.js';

export class PreviewSelectionService {
  constructor(
    private readonly workspaces: Pick<WorkspaceManager, 'workspacePath'>,
    private readonly screenshots: Pick<SelectionScreenshotCapturer, 'captureSelectionScreenshot'>,
    private readonly previewBaseUrl: string,
  ) {}

  async resolve(input: {
    projectId: string;
    sessionId: string;
    request: PreviewSelectionRequest;
  }): Promise<PreviewSelectionResult> {
    const { request } = input;
    const workspaceRoot = this.workspaces.workspacePath(input.projectId);

    const resolvedFiles: string[] = [];
    for (const candidate of request.candidates) {
      const relative = resolveWorkspaceRelativePath(workspaceRoot, candidate.fileName);
      if (relative && !resolvedFiles.includes(relative)) resolvedFiles.push(relative);
    }

    const domPath = request.domPath;

    if (resolvedFiles.length === 1) {
      return { domPath, status: 'resolved', file: resolvedFiles[0] };
    }
    if (resolvedFiles.length >= 2) {
      return { domPath, status: 'ambiguous', candidates: resolvedFiles };
    }

    const screenshot = await this.captureFallbackScreenshot(input.sessionId, request);
    return { domPath, status: 'unsupported', ...(screenshot ? { screenshot } : {}) };
  }

  private async captureFallbackScreenshot(
    sessionId: string,
    request: PreviewSelectionRequest,
  ): Promise<PreviewSelectionResult['screenshot']> {
    const expectedPrefix = `${this.previewBaseUrl}/${sessionId}/`;
    if (!request.previewUrl.startsWith(expectedPrefix)) return undefined;
    const buffer = await this.screenshots.captureSelectionScreenshot({
      url: request.previewUrl,
      clip: request.boundingBox,
      viewport: { width: request.boundingBox.width, height: request.boundingBox.height },
    });
    if (!buffer) return undefined;
    return ArtifactReferenceSchema.parse({
      name: `preview-selection-${sessionId}-${Date.now()}.png`,
      revision: 1,
      sha256: sha256(buffer),
      sizeBytes: buffer.byteLength,
    });
  }
}
