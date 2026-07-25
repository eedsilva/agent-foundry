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
  currentNodeId: 'build',
  version: 1,
  createdAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
} as unknown as Project;

describe('ProjectCard', () => {
  it('links to the project and surfaces name, status and current node', () => {
    const markup = renderToStaticMarkup(<ProjectCard project={project} />);
    expect(markup).toContain('href="/project/project-1"');
    expect(markup).toContain('Issue Radar');
    expect(markup).toContain('data-status="running"');
    expect(markup).toContain('build');
  });

  it('renders one segment per pipeline stage', () => {
    const markup = renderToStaticMarkup(<ProjectCard project={project} />);
    expect([...markup.matchAll(/data-stage="/g)]).toHaveLength(5);
  });
});
