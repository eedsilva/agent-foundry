import { describe, expect, it } from 'vitest';
import { AgentExecutionRequestSchema } from './agent.js';

describe('AgentExecutionRequestSchema', () => {
  it('accepts request-private attachment bytes with their integrity metadata', () => {
    const content = Buffer.from('image-bytes');
    const request = AgentExecutionRequestSchema.parse({
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      stepId: 'plan',
      role: 'architect',
      taskKind: 'planning',
      provider: 'mock',
      model: 'mock',
      prompt: 'Inspect the attached image.',
      cwd: '/workspace',
      mutatesWorkspace: false,
      timeoutMs: 1_000,
      attachments: [
        {
          name: 'knowledge/design/v1.png',
          mediaType: 'image/png',
          sha256: 'a'.repeat(64),
          sizeBytes: content.byteLength,
          contentBase64: content.toString('base64'),
        },
      ],
    });

    expect(Buffer.from(request.attachments![0]!.contentBase64, 'base64')).toEqual(content);
  });
});
