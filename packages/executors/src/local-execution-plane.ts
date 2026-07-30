import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import {
  EmergencyCeilingError,
  ExecutionError,
  RunCancelledError,
  errorMessage,
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
        status: { executionId: parsedRequest.executionId, state: 'completed', result: executionResult },
      });
      return executionResult;
    } catch (error) {
      // A ceiling breach is an orchestrator-level circuit breaker, not a
      // normal execution outcome — it must propagate as a rejection so the
      // orchestrator's own `instanceof EmergencyCeilingError` handling still
      // sees it, exactly as it does today via the aborted signal's `reason`.
      if (error instanceof EmergencyCeilingError) {
        this.executions.delete(parsedRequest.executionId);
        throw error;
      }
      if (error instanceof ZodError) {
        this.executions.delete(parsedRequest.executionId);
        throw error;
      }
      if (error instanceof RunCancelledError) {
        const executionResult = ExecutionResultSchema.parse({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          executionId: parsedRequest.executionId,
          state: 'cancelled',
        });
        this.executions.set(parsedRequest.executionId, {
          status: { executionId: parsedRequest.executionId, state: 'cancelled', result: executionResult },
        });
        return executionResult;
      }
      const details = error instanceof ExecutionError ? error.details : {};
      const executionResult = ExecutionResultSchema.parse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: parsedRequest.executionId,
        state: 'failed',
        error: {
          message: errorMessage(error),
          ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          ...(details.stdout !== undefined ? { stdout: details.stdout } : {}),
          ...(details.stderr !== undefined ? { stderr: details.stderr } : {}),
        },
      });
      this.executions.set(parsedRequest.executionId, {
        status: { executionId: parsedRequest.executionId, state: 'failed', result: executionResult },
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
    const relay = (): void =>
      abort.abort(signal.reason ?? new RunCancelledError(runId));
    if (signal.aborted) {
      relay();
      return () => {};
    }
    signal.addEventListener('abort', relay, { once: true });
    return () => signal.removeEventListener('abort', relay);
  }
}
