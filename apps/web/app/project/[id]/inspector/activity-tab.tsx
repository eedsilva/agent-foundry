'use client';

import React from 'react';
import type { ProjectEvent } from '@agent-foundry/contracts';
import { formatSeconds } from '../format-usage.js';

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

export function ActivityTab({ events, live }: { events: ProjectEvent[]; live: boolean }) {
  return (
    <div className="panel">
      <div className="panelHeader">
        <h2>Linha do tempo</h2>
        <div>
          <span className="pill">{live ? 'ao vivo' : 'polling'}</span>
          <span className="hint">{events.length} eventos</span>
        </div>
      </div>
      <div className="timeline">
        {[...events].reverse().map((event) => {
          const badges = eventBadges(event);
          return (
            <article key={event.id}>
              <span className="timelineDot" />
              <div>
                <div className="eventMeta">
                  <span>
                    <code>{event.type}</code>
                    {badges.map((badge) => (
                      <small key={badge}> · {badge}</small>
                    ))}
                  </span>
                  <time>{new Date(event.createdAt).toLocaleTimeString('pt-BR')}</time>
                </div>
                <p>{event.message}</p>
                {event.nodeId ? (
                  <small>
                    {event.nodeId}
                    {event.runId ? ` · ${event.runId}` : ''}
                  </small>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
