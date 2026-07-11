'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Project, RuntimeInfoResponse } from '@agent-foundry/contracts';
import { createProject, getRuntime, listProjects } from '../lib/api';

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

export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState('Issue Radar');
  const [prd, setPrd] = useState(SAMPLE_PRD);
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoResponse | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void Promise.all([listProjects(), getRuntime()])
      .then(([nextProjects, nextRuntime]) => {
        setProjects(nextProjects);
        setRuntime(nextRuntime);
      })
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
    <div className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">ORQUESTRAÇÃO AUDITÁVEL</p>
          <h1>Transforme um PRD em uma linha de montagem de agentes.</h1>
          <p className="lede">
            Planner, revisores, arquiteto, developer, fixer e tester. Cada passagem deixa artefatos,
            decisões, métricas e checkpoints Git em vez de fumaça de contexto.
          </p>
        </div>
        <div className="runtimeCard">
          <span className={`statusDot ${runtime?.executorMode === 'real' ? 'live' : ''}`} />
          <div>
            <small>EXECUÇÃO</small>
            <strong>{runtime?.executorMode ?? 'conectando…'}</strong>
          </div>
          <div>
            <small>MODELOS ATIVOS</small>
            <strong>{runtime?.models.length ?? '—'}</strong>
          </div>
        </div>
      </section>

      <section className="grid">
        <form className="panel composer" onSubmit={submit}>
          <div className="panelHeader">
            <div>
              <span className="stepNumber">01</span>
              <h2>Forneça o problema</h2>
            </div>
            <span className="hint">mínimo de 50 caracteres</span>
          </div>
          <label>
            Nome do projeto
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
          </label>
          <label>
            PRD
            <textarea value={prd} onChange={(event) => setPrd(event.target.value)} minLength={50} required />
          </label>
          {error ? <p className="errorBox">{error}</p> : null}
          <button className="primaryButton" disabled={submitting}>
            {submitting ? 'Criando e enfileirando…' : 'Fundir projeto →'}
          </button>
        </form>

        <aside className="panel pipelinePanel">
          <div className="panelHeader">
            <div>
              <span className="stepNumber">02</span>
              <h2>Pipeline</h2>
            </div>
          </div>
          <ol className="pipeline">
            {[
              ['PLAN', 'Planejamento + revisão'],
              ['ARCH', 'Arquitetura + revisão'],
              ['BUILD', 'Implementação + code review'],
              ['VERIFY', 'Checks determinísticos + reparo'],
              ['RELEASE', 'Teste adversarial final'],
            ].map(([code, title]) => (
              <li key={code}>
                <code>{code}</code>
                <span>{title}</span>
              </li>
            ))}
          </ol>
          <p className="finePrint">
            O router escolhe modelo por tarefa, risco, contexto, custo, velocidade, confiabilidade e histórico.
            Fallback sem rollback é só corrupção com boa publicidade, então cada tentativa mutável usa Git.
          </p>
        </aside>
      </section>

      <section className="recent">
        <div className="sectionTitle">
          <p className="eyebrow">PROJETOS</p>
          <h2>Execuções recentes</h2>
        </div>
        <div className="projectList">
          {projects.length === 0 ? (
            <p className="emptyState">Nenhuma execução ainda. A forja está fria.</p>
          ) : (
            projects.map((project) => (
              <a className="projectRow" href={`/project/${project.id}`} key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <small>{project.id}</small>
                </div>
                <span className={`pill ${project.status}`}>{project.status}</span>
                <time>{new Date(project.updatedAt).toLocaleString('pt-BR')}</time>
              </a>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
