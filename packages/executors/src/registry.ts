import type { ExecutorHealth } from '@agent-foundry/contracts';
import type { AgentExecutor, ExecutorRegistry } from '@agent-foundry/domain';

export class StaticExecutorRegistry implements ExecutorRegistry {
  private readonly byProvider: Map<string, AgentExecutor>;

  constructor(executors: AgentExecutor[]) {
    this.byProvider = new Map(executors.map((executor) => [executor.provider, executor]));
  }

  get(provider: string): AgentExecutor {
    const executor = this.byProvider.get(provider);
    if (!executor) throw new Error(`No executor registered for provider ${provider}`);
    return executor;
  }

  async health(): Promise<ExecutorHealth[]> {
    return Promise.all([...this.byProvider.values()].map((executor) => executor.health()));
  }
}

export class MockExecutorRegistry implements ExecutorRegistry {
  constructor(private readonly executor: AgentExecutor) {}

  get(): AgentExecutor {
    return this.executor;
  }

  async health(): Promise<ExecutorHealth[]> {
    return [await this.executor.health()];
  }
}
