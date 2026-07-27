import React from 'react';
import type { Project } from '@agent-foundry/contracts';
import { StatusPill } from './status-pill';
import { cn } from '@/lib/utils';

const STAGES = ['plan', 'build', 'verify', 'release'] as const;

export function ProjectCard({ project }: { project: Project }) {
  const reachedIndex = STAGES.findIndex((stage) =>
    (project.currentNodeId ?? '').toLowerCase().startsWith(stage.slice(0, 4)),
  );

  return (
    <a
      href={`/project/${project.id}`}
      data-testid="project-card"
      className="project-card-interactive bg-surface border-hairline rounded-card shadow-card flex flex-col gap-3 border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <strong className="text-ink text-[15px] leading-tight">{project.name}</strong>
        <StatusPill status={project.status} />
      </div>

      <div
        className="flex gap-1"
        role="img"
        aria-label={
          reachedIndex >= 0
            ? `Etapa ${reachedIndex + 1} de ${STAGES.length}`
            : 'Nenhuma etapa concluída'
        }
      >
        {STAGES.map((stage, index) => (
          <span
            key={stage}
            data-stage={stage}
            className={cn(
              'h-1 flex-1 rounded-full',
              reachedIndex >= 0 && index <= reachedIndex ? 'bg-accent' : 'bg-ink/10',
            )}
          />
        ))}
      </div>

      <div className="text-ink-subtle flex items-center justify-between font-mono text-[11px]">
        <span>{project.currentNodeId ?? 'sem nó'}</span>
        <time dateTime={project.updatedAt}>
          {new Date(project.updatedAt).toLocaleString('pt-BR')}
        </time>
      </div>
    </a>
  );
}
