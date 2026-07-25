import type { RouteDecision } from '@agent-foundry/contracts';

export const rowStyle = { display: 'flex', alignItems: 'center', gap: '0.75rem' } as const;

export function isFallback(route: RouteDecision | undefined): boolean {
  return Boolean(route?.executed && route.executed.model.id !== route.selected.model.id);
}
