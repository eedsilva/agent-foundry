'use client';

import React from 'react';
import type { AgentArtifact } from '@agent-foundry/contracts';

export function AgentArtifactView({ artifact }: { artifact: AgentArtifact }) {
  return (
    <section
      // Agent-authored free text (a stack trace, a URL, a hash) is the
      // expected case here, not an exotic one — `[overflow-wrap:anywhere]`
      // is inherited, so setting it once on the root wraps `summary`,
      // `risks`, `decisions` and `nextActions` alike instead of an unbroken
      // token silently clipping (measured: 390px probe, task-3-report.md).
      className="border-hairline mt-3 flex flex-col gap-2 rounded-card border p-3 [overflow-wrap:anywhere]"
      data-testid="agent-artifact-view"
    >
      <div>
        <p className="text-ink-muted text-[11px] uppercase tracking-[0.14em]">Assessment</p>
        <p className="text-ink text-[13px] font-semibold">{artifact.summary}</p>
        <p className="text-ink-muted text-[12px]">Status: {artifact.status}</p>
      </div>
      {artifact.risks.length > 0 ? (
        <div>
          <p className="text-ink text-[12px] font-semibold">Riscos</p>
          <ul className="text-ink-muted list-disc pl-4 text-[12px]">
            {artifact.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {artifact.decisions.length > 0 ? (
        <div>
          <p className="text-ink text-[12px] font-semibold">Decisões</p>
          <ul className="text-ink-muted list-disc pl-4 text-[12px]">
            {artifact.decisions.map((decision) => (
              <li key={decision.title}>
                {decision.title}: {decision.choice} — {decision.rationale}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {artifact.nextActions.length > 0 ? (
        <div>
          <p className="text-ink text-[12px] font-semibold">Próximas ações</p>
          <ul className="text-ink-muted list-disc pl-4 text-[12px]">
            {artifact.nextActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
