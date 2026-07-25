import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project } from '@agent-foundry/contracts';
import { ProjectCard } from './project-card';

const project = {
  schemaVersion: '1',
  id: 'project-1',
  name: 'Issue Radar',
  status: 'running',
  currentNodeId: 'deploy-attempt-3',
  version: 1,
  createdAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
} as unknown as Project;

// Reads the fill state of each `data-stage` segment in document order, e.g.
// ['plan:filled', 'architecture:filled', 'build:unfilled', ...].
function stageFillStates(markup: string): string[] {
  return [...markup.matchAll(/data-stage="([a-z]+)" class="([^"]*)"/g)].map(
    ([, stage, className]) =>
      `${stage}:${(className ?? '').includes('bg-accent') ? 'filled' : 'unfilled'}`,
  );
}

describe('ProjectCard', () => {
  it('links to the project and surfaces name, status and current node', () => {
    const markup = renderToStaticMarkup(<ProjectCard project={project} />);
    expect(markup).toContain('href="/project/project-1"');
    expect(markup).toContain('Issue Radar');
    expect(markup).toContain('data-status="running"');
    // 'deploy-attempt-3' does not collide with any STAGES literal (plan/architecture/build/
    // verify/release), so this only passes if the current-node element itself renders it.
    expect(markup).toContain('deploy-attempt-3');
  });

  it('falls back to "sem nó" when there is no current node', () => {
    const noNode = { ...project, currentNodeId: null } as unknown as Project;
    const markup = renderToStaticMarkup(<ProjectCard project={noNode} />);
    expect(markup).toContain('sem nó');
  });

  it('renders one segment per pipeline stage', () => {
    const markup = renderToStaticMarkup(<ProjectCard project={project} />);
    expect([...markup.matchAll(/data-stage="/g)]).toHaveLength(5);
  });

  it('fills the stages up to and including the current node', () => {
    const atBuild = { ...project, currentNodeId: 'build' } as unknown as Project;
    const markup = renderToStaticMarkup(<ProjectCard project={atBuild} />);
    expect(stageFillStates(markup)).toEqual([
      'plan:filled',
      'architecture:filled',
      'build:filled',
      'verify:unfilled',
      'release:unfilled',
    ]);
  });

  it('fills nothing when the current node matches no known stage', () => {
    const unknown = { ...project, currentNodeId: 'onboarding' } as unknown as Project;
    const markup = renderToStaticMarkup(<ProjectCard project={unknown} />);
    expect(stageFillStates(markup)).toEqual([
      'plan:unfilled',
      'architecture:unfilled',
      'build:unfilled',
      'verify:unfilled',
      'release:unfilled',
    ]);
  });

  it('fills nothing when there is no current node', () => {
    const noNode = { ...project, currentNodeId: null } as unknown as Project;
    const markup = renderToStaticMarkup(<ProjectCard project={noNode} />);
    expect(stageFillStates(markup)).toEqual([
      'plan:unfilled',
      'architecture:unfilled',
      'build:unfilled',
      'verify:unfilled',
      'release:unfilled',
    ]);
  });
});
