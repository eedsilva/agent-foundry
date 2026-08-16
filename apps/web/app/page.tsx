'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Project } from '@agent-foundry/contracts';
import { createProject, listProjects } from '../lib/api';
import { ProjectCard } from '@/components/project-card';
import { PaneState } from '@/components/pane-state';
import { ERROR_BOX, FIELD, LABEL, PAGE, PANEL, PANEL_TITLE, PRIMARY_BTN, TEXTAREA } from '@/lib/ui';
import { cn } from '@/lib/utils';

const SAMPLE_PRD = `# PRD: Issue Radar

## Problema
Equipes pequenas perdem bugs e decisões porque feedback chega por muitos canais.

## Usuários
Engenheiros e product managers em equipes de 3 a 20 pessoas.

## Primeira versão
- Criar projetos.
- Registrar issues com título, descrição, prioridade e status.
- Filtrar por status e prioridade.
- Mostrar um dashboard simples com contagens.
- Persistir os dados.
- Ter estados de loading, vazio e erro.

## Critérios de aceite
- O usuário consegue criar, editar e concluir uma issue.
- Dados continuam disponíveis após reiniciar a aplicação.
- Entradas inválidas retornam mensagens claras.
- Fluxos principais têm testes automatizados.

## Fora de escopo
Login social, billing, colaboração em tempo real e aplicativo móvel.`;

export const PIPELINE_NODES = [
  { code: 'PLAN', title: 'Planejamento + revisão' },
  { code: 'ARCH', title: 'Arquitetura + revisão' },
  { code: 'BUILD', title: 'Implementação + code review' },
  { code: 'VERIFY', title: 'Checks determinísticos + reparo' },
  { code: 'RELEASE', title: 'Teste adversarial final' },
] as const;

export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState('Issue Radar');
  const [prd, setPrd] = useState(SAMPLE_PRD);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const project = await createProject({ name, prd, workflowId: 'web-app-v1' });
      router.push(`/project/${project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  }

  return (
    <div className={PAGE}>
      <header className="mb-8 max-w-[62ch]">
        <h1 className="text-ink text-[32px] leading-tight font-semibold tracking-[-0.02em]">
          Transforme um PRD em uma linha de montagem de agentes.
        </h1>
        <p className="text-ink-muted mt-3 text-[15px] leading-relaxed">
          Planner, revisores, arquiteto, developer, fixer e tester. Cada passagem deixa artefatos,
          decisões, métricas e checkpoints Git.
        </p>
      </header>

      <section className="mb-10 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.9fr)]">
        <form onSubmit={submit} className={cn(PANEL, 'flex flex-col gap-4')}>
          <h2 className={PANEL_TITLE}>Forneça o problema</h2>

          <label className={LABEL}>
            Nome do projeto
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              className={FIELD}
            />
          </label>

          <label className={LABEL}>
            PRD <span className="text-ink-subtle font-normal">mínimo de 50 caracteres</span>
            <textarea
              value={prd}
              onChange={(event) => setPrd(event.target.value)}
              minLength={50}
              required
              className={cn(TEXTAREA, 'min-h-[260px]')}
            />
          </label>

          {error ? (
            <p role="alert" className={ERROR_BOX}>
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            aria-busy={submitting}
            className={`${PRIMARY_BTN} py-2.5`}
          >
            {submitting ? 'Criando e enfileirando…' : 'Fundir projeto'}
          </button>
        </form>

        <aside className={PANEL}>
          <h2 className={cn(PANEL_TITLE, 'mb-4')}>Pipeline</h2>
          <ol className="flex flex-col gap-3">
            {PIPELINE_NODES.map((node) => (
              <li key={node.code} className="flex items-baseline gap-3">
                <code className="text-accent-strong w-[62px] shrink-0 font-mono text-[11px] font-bold">
                  {node.code}
                </code>
                <span className="text-ink-muted text-[13px]">{node.title}</span>
              </li>
            ))}
          </ol>
        </aside>
      </section>

      <section>
        <h2 className="text-ink mb-4 text-[20px] font-semibold tracking-[-0.01em]">Projetos</h2>
        {projects.length === 0 ? (
          <PaneState
            kind="empty"
            title="Nenhuma execução ainda."
            hint="Descreva o problema acima e funda o primeiro projeto."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
