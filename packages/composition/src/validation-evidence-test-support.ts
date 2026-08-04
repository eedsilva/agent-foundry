import { MockAgentExecutor } from '@agent-foundry/executors';
import type { ExecutorRegistry } from '@agent-foundry/domain';
import type { ExecutorHealth } from '@agent-foundry/contracts';

/**
 * Supplies the real-mode validation campaign with deterministic local execution
 * while preserving the provider/model identity selected by the campaign.
 */
export function createValidationCampaignTestExecutorRegistry(): ExecutorRegistry {
  class ValidationCampaignMockExecutor extends MockAgentExecutor {
    override async execute(...args: Parameters<MockAgentExecutor['execute']>) {
      const [request] = args;
      const result = await super.execute(...args);
      return {
        ...result,
        provider: request.provider,
        model: request.model,
        executedModel: request.model,
      };
    }
  }

  const executor = new ValidationCampaignMockExecutor();
  const providers = ['codex', 'claude', 'opencode', 'agy', 'glm'] as const;
  const health: ExecutorHealth[] = providers.map((provider) => ({
    provider,
    available: true,
    version: 'validation-test',
    message: 'Deterministic validation test executor is enabled.',
    rateLimit: {
      limit: 1_000,
      remaining: 1_000,
      resetAt: '2099-01-01T00:00:00.000Z',
    },
  }));
  return {
    get: () => executor,
    health: async () => health,
  } satisfies ExecutorRegistry;
}
