import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import { AgentArtifactSchema } from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { RunCancelledError } from '@agent-foundry/domain';
import { buildArtifact, mutateWorkspace } from './fixtures/fake-cli/fake-cli-core.mjs';

export class MockAgentExecutor implements AgentExecutor {
  readonly provider = 'mock';

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (signal?.aborted) throw new RunCancelledError(request.runId);
    const startedAt = Date.now();
    const mockModel = `mock:${request.provider}/${request.model || 'default'}`;
    if (onEvent) await this.emitMockStream(request, onEvent);
    // Delegates to the shared deterministic core (fixtures/fake-cli) so mock
    // mode and the nightly real-mode pipeline regression can never drift.
    if (request.mutatesWorkspace) await mutateWorkspace(request.cwd, request.stepId, 'mock');
    const output = AgentArtifactSchema.parse(
      buildArtifact(
        {
          stepId: request.stepId,
          role: request.role,
          taskKind: request.taskKind,
          outputSchemaId:
            typeof request.outputSchema?.$id === 'string' ? request.outputSchema.$id : undefined,
        },
        // Mock mode drives the browser-verification path, so its second
        // planned task stays browser-visible.
        { label: 'Mock', t2AcceptanceMode: 'browser-visible' },
      ),
    );
    const stdout = JSON.stringify(output);

    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'mock',
      model: mockModel,
      executedModel: mockModel,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr: '',
      output,
      usage: { inputTokens: 100, outputTokens: 100, estimatedCostUsd: 0 },
    };
  }

  /**
   * Local dev/demo mode has no real CLI stdout to tap, so it has nothing to
   * show the chat UI's live-activity rendering without this. Small delays
   * make it visibly "stream" rather than arrive as one instantaneous burst;
   * only runs when a caller actually wants events (onEvent provided).
   */
  private async emitMockStream(
    request: AgentExecutionRequest,
    onEvent: (event: ExecutorStreamEvent) => void,
  ): Promise<void> {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    onEvent({ type: 'status', phase: 'started' });
    await wait(200);
    onEvent({ type: 'assistant_delta', text: `Working on ${request.stepId}...` });
    await wait(200);
    onEvent({ type: 'tool_start', toolName: 'MockTool', summary: `Reviewing ${request.taskKind}` });
    await wait(200);
    onEvent({
      type: 'tool_end',
      toolName: 'MockTool',
      summary: `Reviewed ${request.taskKind}`,
      ok: true,
    });
    await wait(200);
    onEvent({ type: 'assistant_delta', text: 'Done.' });
  }

  async health(): Promise<ExecutorHealth> {
    return {
      provider: 'mock',
      available: true,
      version: '1',
      message: 'Deterministic mock executor is enabled',
    };
  }
}
