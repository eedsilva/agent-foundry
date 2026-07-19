import { describe, expect, it, vi } from 'vitest';
import type { PreviewSelectionRequest } from '@agent-foundry/contracts';
import { PreviewSelectionService } from './preview-selection-service.js';

const boundingBox = { x: 0, y: 0, width: 10, height: 10 };
const computedStyle = {};

function baseRequest(overrides: Partial<PreviewSelectionRequest> = {}): PreviewSelectionRequest {
  return {
    previewUrl: 'http://127.0.0.1:4000/preview/session-1/?token=abc',
    domPath: 'div[1]',
    boundingBox,
    computedStyle,
    candidates: [],
    ...overrides,
  };
}

function makeService(
  overrides: {
    workspacePath?: string;
    captureSelectionScreenshot?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const workspaces = { workspacePath: () => overrides.workspacePath ?? '/data/ws' };
  const screenshots = {
    captureSelectionScreenshot: overrides.captureSelectionScreenshot ?? vi.fn(async () => null),
  };
  const service = new PreviewSelectionService(workspaces, screenshots, {
    previewBaseUrl: 'http://127.0.0.1:4000/preview',
  });
  return { service, screenshots };
}

describe('PreviewSelectionService.resolve', () => {
  it('resolves a single in-workspace candidate', async () => {
    const { service } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({
        candidates: [
          { fileName: 'src/Greeting.tsx', line: 4, column: 3, componentName: 'Greeting' },
        ],
      }),
    });
    expect(result).toMatchObject({ status: 'resolved', file: 'src/Greeting.tsx' });
  });

  it('reports ambiguous for 2+ distinct in-workspace candidates', async () => {
    const { service } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({
        candidates: [
          { fileName: 'src/Card.tsx', line: 12, column: 3, componentName: 'Card' },
          { fileName: 'src/Button.tsx', line: 8, column: 5, componentName: 'Button' },
        ],
      }),
    });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toEqual(['src/Card.tsx', 'src/Button.tsx']);
  });

  it('resolves two different list-item candidate sets to the same single file', async () => {
    const { service } = makeService();
    const candidateFor = (): PreviewSelectionRequest['candidates'] => [
      { fileName: 'src/ListItem.tsx', line: 6, column: 2, componentName: 'ListItem' },
    ];
    const first = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ candidates: candidateFor() }),
    });
    const second = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ candidates: candidateFor() }),
    });
    expect(first).toEqual(second);
    expect(first.status).toBe('resolved');
    expect(first.file).toBe('src/ListItem.tsx');
  });

  it('drops candidates that escape the workspace root and rejects the whole selection as unsupported when none remain', async () => {
    const { service, screenshots } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({
        candidates: [{ fileName: '../../etc/passwd', line: 1, column: 1 }],
      }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.file).toBeUndefined();
    expect(result.candidates).toBeUndefined();
    expect(screenshots.captureSelectionScreenshot).toHaveBeenCalledTimes(1);
  });

  it('treats a generated/non-React element (no candidates) as unsupported and attaches a screenshot when capture succeeds', async () => {
    const buffer = Buffer.from('fake-png');
    const { service, screenshots } = makeService({
      captureSelectionScreenshot: vi.fn(async () => buffer),
    });
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ candidates: [] }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.screenshot).toBeDefined();
    expect(screenshots.captureSelectionScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:4000/preview/session-1/?token=abc',
        clip: boundingBox,
      }),
    );
  });

  it('omits the screenshot when previewUrl does not match the session prefix', async () => {
    const { service, screenshots } = makeService();
    const result = await service.resolve({
      projectId: 'proj-1',
      sessionId: 'session-1',
      request: baseRequest({ previewUrl: 'http://evil.example/steal', candidates: [] }),
    });
    expect(result.status).toBe('unsupported');
    expect(result.screenshot).toBeUndefined();
    expect(screenshots.captureSelectionScreenshot).not.toHaveBeenCalled();
  });
});
