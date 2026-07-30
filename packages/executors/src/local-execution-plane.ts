import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import {
  RunCancelledError,
  toExecutionResult,
  type ExecutionPlane,
  type ExecutionStatus,
  type ExecutorRegistry,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { ZodError } from 'zod';

type LocalExecutionRecord = {
  status: ExecutionStatus;
  cancel?: () => void;
};

/**
 * Runs agent CLIs in-process, in the same environment as the control plane.
 * This is the trusted, local-development fallback the roadmap calls for
 * (`v07-control-execution-plane`) — production hosting needs a real remote
 * `ExecutionPlane`, which lands with the sandbox runner (`v07-sandbox-runner`).
 */
export class LocalExecutionPlane implements ExecutionPlane {
  private readonly executions = new Map<string, LocalExecutionRecord>();

  constructor(
    private readonly executors: ExecutorRegistry,
    private readonly workspaces: Pick<WorkspaceManager, 'workspacePath'>,
  ) {}

  async submit(
    request: ExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<ExecutionResult> {
    const parsedRequest = ExecutionRequestSchema.parse(request);
    const unsupportedCapabilities = getUnsupportedLocalCapabilities(parsedRequest);
    if (unsupportedCapabilities.length > 0) {
      const executionResult = ExecutionResultSchema.parse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: parsedRequest.executionId,
        state: 'failed',
        error: {
          message: `Local execution plane cannot enforce requested capabilities: ${unsupportedCapabilities.join(', ')}`,
        },
      });
      this.executions.set(parsedRequest.executionId, {
        status: {
          executionId: parsedRequest.executionId,
          state: 'failed',
          result: executionResult,
        },
      });
      return executionResult;
    }
    const executor = this.executors.get(parsedRequest.agent.provider);
    const cwd = this.workspaces.workspacePath(parsedRequest.workspace.projectId);
    const abort = new AbortController();
    const unlinkAbort = this.forwardAbort(signal, abort, parsedRequest.agent.runId);
    this.executions.set(parsedRequest.executionId, {
      status: { executionId: parsedRequest.executionId, state: 'running' },
      cancel: () => abort.abort(new RunCancelledError(parsedRequest.agent.runId)),
    });
    try {
      const result = await executor.execute({ ...parsedRequest.agent, cwd }, abort.signal, onEvent);
      const executionResult = ExecutionResultSchema.parse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: parsedRequest.executionId,
        state: 'completed',
        agent: result,
      });
      this.executions.set(parsedRequest.executionId, {
        status: {
          executionId: parsedRequest.executionId,
          state: 'completed',
          result: executionResult,
        },
      });
      return executionResult;
    } catch (error) {
      if (error instanceof ZodError) {
        this.executions.delete(parsedRequest.executionId);
        throw error;
      }
      let mappedResult: ExecutionResult;
      try {
        mappedResult = toExecutionResult(parsedRequest.executionId, error);
      } catch (mappedError) {
        this.executions.delete(parsedRequest.executionId);
        throw mappedError;
      }
      const executionResult = ExecutionResultSchema.parse(mappedResult);
      this.executions.set(parsedRequest.executionId, {
        status: {
          executionId: parsedRequest.executionId,
          state: executionResult.state,
          result: executionResult,
        },
      });
      return executionResult;
    } finally {
      unlinkAbort();
    }
  }

  async cancel(executionId: string): Promise<void> {
    this.executions.get(executionId)?.cancel?.();
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    return this.executions.get(executionId)?.status ?? { executionId, state: 'pending' };
  }

  private forwardAbort(
    signal: AbortSignal | undefined,
    abort: AbortController,
    runId: string,
  ): () => void {
    if (!signal) return () => {};
    const relay = (): void => abort.abort(signal.reason ?? new RunCancelledError(runId));
    if (signal.aborted) {
      relay();
      return () => {};
    }
    signal.addEventListener('abort', relay, { once: true });
    return () => signal.removeEventListener('abort', relay);
  }
}

function getUnsupportedLocalCapabilities(request: ExecutionRequest): string[] {
  return [
    request.tools.length > 0 ? 'tools' : undefined,
    request.networkPolicy.mode !== 'none' ? 'networkPolicy' : undefined,
    request.secrets.some(({ name, ref }) => ref !== name) ? 'secrets' : undefined,
  ].filter((capability): capability is string => capability !== undefined);
}
