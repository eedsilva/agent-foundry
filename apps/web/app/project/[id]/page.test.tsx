import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as page from './page';

type ProvisioningErrorView = (props: { error: string }) => React.ReactElement;
type TimelineView = (props: { children: React.ReactNode }) => React.ReactElement;

const { ProjectProvisioningError, ProjectTimeline } = page as typeof page & {
  ProjectProvisioningError: ProvisioningErrorView;
  ProjectTimeline: TimelineView;
};

describe('ProjectPage provisioning failure', () => {
  it('renders a concise provisioning error with a timeline link', () => {
    expect(ProjectProvisioningError).toBeTypeOf('function');

    const markup = renderToStaticMarkup(
      <ProjectProvisioningError error="Provisionamento indisponível." />,
    );

    expect(markup).toContain('Provisionamento indisponível.');
    expect(markup).toContain('href="#project-timeline"');
    expect(markup).toContain('Ver detalhes na linha do tempo');
  });

  it('renders the timeline anchor target', () => {
    expect(ProjectTimeline).toBeTypeOf('function');

    const markup = renderToStaticMarkup(
      <ProjectTimeline>
        <p>Linha do tempo</p>
      </ProjectTimeline>,
    );

    expect(markup).toContain('<section id="project-timeline"');
  });
});
