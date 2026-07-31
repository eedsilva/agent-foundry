'use client';

import React from 'react';
import { ProvisioningFailureDiagnosticSchema, type ProjectEvent } from '@agent-foundry/contracts';
import { EmptyState } from '@/components/empty-state';
import { StatusPill } from '@/components/status-pill';
import { formatSeconds } from '../format-usage.js';
import { HINT, PANEL, PANEL_HEADER, PANEL_TITLE } from '@/lib/ui';

function eventBadges(event: ProjectEvent): string[] {
  const data = event.data;
  const badges: string[] = [];
  if (typeof data.modelId === 'string') badges.push(data.modelId);
  if (typeof data.provider === 'string') badges.push(data.provider);
  if (typeof data.durationMs === 'number') badges.push(formatSeconds(data.durationMs));
  if (Array.isArray(data.fallbacks) && data.fallbacks.length > 0) {
    badges.push(`fallbacks: ${data.fallbacks.join(', ')}`);
  }
  if (typeof data.name === 'string' && typeof data.revision === 'number') {
    badges.push(`${data.name} r${data.revision}`);
  }
  return badges;
}

function eventDiagnostic(
  event: ProjectEvent,
): { label: string; value: string; summary?: string; context?: string } | null {
  if (event.type === 'preview.failed' && event.data.diagnostic) {
    return {
      label: 'Diagnóstico do preview',
      value: JSON.stringify(event.data.diagnostic, null, 2),
    };
  }
  if (event.type !== 'project.provisioning_failed' || !event.data.diagnostic) return null;
  const diagnostic = ProvisioningFailureDiagnosticSchema.safeParse(event.data.diagnostic);
  if (!diagnostic.success) return null;
  return {
    label: 'Diagnóstico do provisionamento',
    summary: diagnostic.data.summary,
    context: diagnostic.data.context,
    value: diagnostic.data.logs,
  };
}

export function ActivityTab({ events, live }: { events: ProjectEvent[]; live: boolean }) {
  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>Linha do tempo</h2>
        <div className="flex items-center gap-2">
          <StatusPill status={live ? 'running' : 'queued'} label={live ? 'ao vivo' : 'polling'} />
          <span className={HINT}>{events.length} eventos</span>
        </div>
      </div>
      {events.length === 0 ? (
        <EmptyState title="Nenhum evento ainda." />
      ) : (
        <div aria-live="polite" className="border-hairline flex flex-col gap-4 border-l pl-4">
          {[...events].reverse().map((event) => {
            const badges = eventBadges(event);
            const diagnostic = eventDiagnostic(event);
            return (
              <article key={event.id} className="relative">
                <span
                  aria-hidden
                  className="bg-accent absolute top-1.5 -left-[21px] size-2 rounded-full"
                />
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <code className="text-accent-strong font-mono text-[11px]">{event.type}</code>
                    {badges.map((badge) => (
                      <small key={badge} className="text-ink-subtle font-mono text-[10px]">
                        {' '}
                        · {badge}
                      </small>
                    ))}
                  </span>
                  <time className="text-ink-subtle shrink-0 font-mono text-[10px]">
                    {new Date(event.createdAt).toLocaleTimeString('pt-BR')}
                  </time>
                </div>
                <p className="text-ink mt-1 text-[13px] leading-snug">{event.message}</p>
                {diagnostic ? (
                  <div className="mt-2">
                    {diagnostic.summary ? (
                      <p className="text-ink text-[12px]">{diagnostic.summary}</p>
                    ) : null}
                    {diagnostic.context ? (
                      <p className="text-ink-subtle mt-1 text-[11px]">{diagnostic.context}</p>
                    ) : null}
                    <details className="mt-2">
                      <summary className="text-ink-subtle cursor-pointer text-[11px]">
                        {diagnostic.label}
                      </summary>
                      <pre className="bg-surface-muted text-ink-subtle mt-2 max-h-64 overflow-auto rounded p-2 font-mono text-[10px] whitespace-pre-wrap">
                        {diagnostic.value}
                      </pre>
                    </details>
                  </div>
                ) : null}
                {event.nodeId ? (
                  <small className="text-ink-subtle font-mono text-[10px]">
                    {event.nodeId}
                    {event.runId ? ` · ${event.runId}` : ''}
                  </small>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
