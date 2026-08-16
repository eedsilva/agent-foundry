'use client';

import React, { useMemo } from 'react';
import {
  taskCategoryLevels,
  type ModelDefinition,
  type RouteDecision,
} from '@agent-foundry/contracts';
import { PaneState } from '@/components/pane-state';
import { HINT, PANEL, PANEL_HEADER, PANEL_TITLE, SECTION_TITLE } from '@/lib/ui';
import { isFallback } from './shared';

export type RouteEntry = { artifact: string; route: RouteDecision };

/** The vendors a table can name — `Provider` minus the `mock` test double. */
type Executor = ModelDefinition['provider'];

/**
 * The ordered executors the table offered, with the one that ran marked. The
 * ordering *is* the decision since #326, so the list is the whole story — there
 * are no dimension scores behind it to explain.
 */
function ExecutorLadder({
  executors,
  ran,
}: {
  executors: readonly Executor[];
  ran: Executor | undefined;
}) {
  return (
    <ol className="mt-2 flex list-none flex-wrap gap-1.5 p-0">
      {executors.map((executor, index) => {
        const used = executor === ran;
        return (
          <li
            key={executor}
            className={`rounded-full px-2 py-0.5 font-mono text-[11px] ${
              used ? 'bg-accent-wash text-ink font-bold' : 'bg-surface text-ink-subtle'
            }`}
          >
            <span className={used ? 'text-ink' : 'text-ink-subtle'}>{index + 1}.</span> {executor}
            {used ? <span className="sr-only"> (executor que rodou)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Which entry actually ran. The ladder marks the executed executor, so the
 * position beside it has to describe the same one — on a fallback, `selectedIndex`
 * still points at the entry that was chosen and then failed.
 */
function ranEntry(table: NonNullable<RouteDecision['routingTable']>, ran: Executor): number {
  const index = table.executors.indexOf(ran);
  return index >= 0 ? index : table.selectedIndex;
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
        <span className={HINT}>tabela auditável</span>
      </div>
      <div className="flex flex-col gap-4">
        {Array.from(routeGroups, ([category, groupedRoutes]) => (
          <section key={category} className="flex flex-col gap-2">
            <h3 className={SECTION_TITLE}>{category}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {groupedRoutes.map(({ artifact, route }) => {
                const executed = route.executed ?? route.selected;
                const usedFallback = isFallback(route);
                const table = route.routingTable;
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
                      // `text-warn` on the sunken card is 1.9:1; `--ink` on the
                      // warn wash is 17.1:1 and the wash still reads as a warning.
                      <p className="text-ink bg-warn/10 mt-1 inline-block rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide uppercase">
                        fallback de {route.selected.model.id}
                      </p>
                    ) : null}
                    {table ? (
                      <>
                        <p className="text-ink-muted mt-3 text-[12px]">
                          tabela <span className="text-ink font-mono">{table.source}</span> ·{' '}
                          {table.taskKind} · entrada {ranEntry(table, executed.model.provider) + 1}/
                          {table.executors.length}
                        </p>
                        <ExecutorLadder executors={table.executors} ran={executed.model.provider} />
                      </>
                    ) : (
                      // Decisions persisted under the scored router that #326
                      // replaced; their dimension scores are not shown because
                      // nothing computes them any more.
                      <p className="text-ink-muted mt-3 text-[12px]">
                        rota sem tabela (anterior ao roteamento por tabela)
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {routes.length === 0 ? (
          <PaneState kind="empty" title="As rotas aparecem quando os agentes começarem." />
        ) : null}
      </div>
    </section>
  );
}
