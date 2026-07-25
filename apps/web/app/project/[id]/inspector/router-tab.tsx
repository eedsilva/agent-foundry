'use client';

import React, { useMemo } from 'react';
import { taskCategoryLevels, type RouteDecision } from '@agent-foundry/contracts';
import { EmptyState } from '@/components/empty-state';
import { HINT, PANEL, PANEL_HEADER, PANEL_TITLE, SECTION_TITLE } from '../ui';
import { isFallback } from './shared';

export type RouteEntry = { artifact: string; route: RouteDecision };

function Score({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-hairline flex justify-between gap-2 border-t pt-1.5">
      <dt className="text-ink-subtle text-[11px]">{label}</dt>
      <dd className="text-ink m-0 font-mono text-[11px]">{value}</dd>
    </div>
  );
}

export function RouterTab({ routes }: { routes: RouteEntry[] }) {
  const routeGroups = useMemo(() => {
    const groups = new Map<string, RouteEntry[]>();
    for (const item of routes) {
      const root = taskCategoryLevels(item.route.profile.category)[0]!;
      const group = groups.get(root);
      if (group) group.push(item);
      else groups.set(root, [item]);
    }
    return groups;
  }, [routes]);

  return (
    <section className={PANEL} data-testid="router-decisions">
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Decisões do model router</h2>
        <span className={HINT}>score auditável</span>
      </div>
      <div className="flex flex-col gap-4">
        {Array.from(routeGroups, ([category, groupedRoutes]) => (
          <section key={category} className="flex flex-col gap-2">
            <h3 className={SECTION_TITLE}>{category}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {groupedRoutes.map(({ artifact, route }) => {
                const executed = route.executed ?? route.selected;
                const usedFallback = isFallback(route);
                return (
                  <article
                    key={`${artifact}-${route.routeId}`}
                    data-testid="route-card"
                    className="border-hairline rounded-card bg-surface-sunken border p-3"
                  >
                    <p className="text-ink-subtle font-mono text-[11px] break-words">{artifact}</p>
                    <p className="text-ink-subtle font-mono text-[11px]">
                      {route.profile.category} · taxonomy v{route.profile.taxonomyVersion}
                    </p>
                    {route.profile.features.length > 0 ? (
                      <p className="text-ink-muted mt-1 text-[12px]">
                        features: {route.profile.features.join(', ')}
                      </p>
                    ) : null}
                    <h4 className="text-ink mt-2 text-[13px] font-semibold">{executed.model.id}</h4>
                    <p className="text-ink-muted text-[12px]">
                      {executed.model.provider} · {executed.model.model || 'default da CLI'}
                    </p>
                    {usedFallback ? (
                      <p className="text-warn mt-1 font-mono text-[10px] font-bold tracking-wide uppercase">
                        fallback de {route.selected.model.id}
                      </p>
                    ) : null}
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
                      <Score label="total" value={executed.score.total.toFixed(3)} />
                      <Score label="capability" value={executed.score.capability.toFixed(3)} />
                      <Score label="reliability" value={executed.score.reliability.toFixed(3)} />
                      <Score label="context" value={executed.score.context.toFixed(3)} />
                      <Score label="speed" value={executed.score.speed.toFixed(3)} />
                      <Score label="cost score" value={executed.score.cost.toFixed(3)} />
                      <Score
                        label="custo estimado"
                        value={
                          executed.score.estimatedCostUsd === null
                            ? 'quota'
                            : `$${executed.score.estimatedCostUsd.toFixed(4)}`
                        }
                      />
                      <Score label="billing" value={executed.model.billingMode} />
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {routes.length === 0 ? (
          <EmptyState title="As rotas aparecem quando os agentes começarem." />
        ) : null}
      </div>
    </section>
  );
}
