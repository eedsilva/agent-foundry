'use client';

import React, { useMemo } from 'react';
import { taskCategoryLevels, type RouteDecision } from '@agent-foundry/contracts';
import { isFallback } from './shared';

export type RouteEntry = { artifact: string; route: RouteDecision };

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
    <section className="panel routesPanel" data-testid="router-decisions">
      <div className="panelHeader">
        <h2>Decisões do model router</h2>
        <span className="hint">score auditável</span>
      </div>
      <div>
        {Array.from(routeGroups, ([category, groupedRoutes]) => (
          <section key={category}>
            <h3>{category}</h3>
            <div className="routeGrid">
              {groupedRoutes.map(({ artifact, route }) => {
                const executed = route.executed ?? route.selected;
                const usedFallback = isFallback(route);
                return (
                  <article key={`${artifact}-${route.routeId}`} data-testid="route-card">
                    <p className="eyebrow">{artifact}</p>
                    <p className="eyebrow">
                      {route.profile.category} · taxonomy v{route.profile.taxonomyVersion}
                    </p>
                    {route.profile.features.length > 0 ? (
                      <p>features: {route.profile.features.join(', ')}</p>
                    ) : null}
                    <h4>{executed.model.id}</h4>
                    <p>
                      {executed.model.provider} · {executed.model.model || 'default da CLI'}
                    </p>
                    {usedFallback ? (
                      <p className="fallbackNotice">fallback de {route.selected.model.id}</p>
                    ) : null}
                    <dl>
                      <div>
                        <dt>total</dt>
                        <dd>{executed.score.total.toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt>capability</dt>
                        <dd>{executed.score.capability.toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt>reliability</dt>
                        <dd>{executed.score.reliability.toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt>context</dt>
                        <dd>{executed.score.context.toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt>speed</dt>
                        <dd>{executed.score.speed.toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt>cost score</dt>
                        <dd>{executed.score.cost.toFixed(3)}</dd>
                      </div>
                      <div>
                        <dt>custo estimado</dt>
                        <dd>
                          {executed.score.estimatedCostUsd === null
                            ? 'quota'
                            : `$${executed.score.estimatedCostUsd.toFixed(4)}`}
                        </dd>
                      </div>
                      <div>
                        <dt>billing</dt>
                        <dd>{executed.model.billingMode}</dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {routes.length === 0 ? (
          <p className="emptyState">As rotas aparecem quando os agentes começarem.</p>
        ) : null}
      </div>
    </section>
  );
}
