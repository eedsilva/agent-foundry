import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectProvisioningError, ProjectTimeline } from './page';

describe('ProjectPage provisioning failure', () => {
  it('renders a concise provisioning error with a timeline link', () => {
    const markup = renderToStaticMarkup(
      <ProjectProvisioningError error="Provisionamento indisponível." />,
    );

    expect(markup).toContain('Provisionamento indisponível.');
    expect(markup).toContain('href="#project-timeline"');
    expect(markup).toContain('Ver detalhes na linha do tempo');
  });

  it('renders the timeline anchor target', () => {
    const markup = renderToStaticMarkup(
      <ProjectTimeline>
        <p>Linha do tempo</p>
      </ProjectTimeline>,
    );

    expect(markup).toContain('<section id="project-timeline"');
  });
});
