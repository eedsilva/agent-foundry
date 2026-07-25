import type { RouteDecision } from '@agent-foundry/contracts';

export function isFallback(route: RouteDecision | undefined): boolean {
  return Boolean(route?.executed && route.executed.model.id !== route.selected.model.id);
}
