import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionRequest,
  type ExecutionResult,
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

/**
 * Runs agent CLIs in-process, in the same environment as the control plane.
 * This is the trusted, local-development fallback the roadmap calls for
 * (`v07-control-execution-plane`) — production hosting needs a real remote
 * `ExecutionPlane`, which lands with the sandbox runner (`v07-sandbox-runner`).
 */
export class LocalExecutionPlane implements ExecutionPlane {
  constructor(
    private readonly executors: ExecutorRegistry,
    private readonly workspaces: Pick<WorkspaceManager, 'workspacePath'>,
  ) {}

  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const executor = this.executors.get(request.agent.provider);
    const cwd = this.workspaces.workspacePath(request.workspace.projectId);
    try {
      const result = await executor.execute({ ...request.agent, cwd }, signal);
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'completed',
        agent: result,
      };
    } catch (error) {
      // A ceiling breach is an orchestrator-level circuit breaker, not a
      // normal execution outcome — it must propagate as a rejection so the
      // orchestrator's own `instanceof EmergencyCeilingError` handling still
      // sees it, exactly as it does today via the aborted signal's `reason`.
      if (error instanceof EmergencyCeilingError) throw error;
      if (error instanceof RunCancelledError) {
        return {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          executionId: request.executionId,
          state: 'cancelled',
        };
      }
      const details = error instanceof ExecutionError ? error.details : {};
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'failed',
        error: {
          message: errorMessage(error),
          ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          ...(details.stdout !== undefined ? { stdout: details.stdout } : {}),
          ...(details.stderr !== undefined ? { stderr: details.stderr } : {}),
        },
      };
    }
  }

  // ponytail: local dev execution is in-process and synchronous — the
  // AbortSignal passed to submit() already cancels it. Out-of-band
  // cancel/observe (e.g. reconciling after a control-plane restart) is
  // meaningful only for a real remote runner; it lands with v07-sandbox-runner.
  async cancel(_executionId: string): Promise<void> {
    throw new Error(
      'LocalExecutionPlane does not support out-of-band cancel; use the AbortSignal passed to submit().',
    );
  }

  async status(_executionId: string): Promise<ExecutionStatus> {
    throw new Error(
      'LocalExecutionPlane does not support out-of-band status; local execution is synchronous.',
    );
  }
}
