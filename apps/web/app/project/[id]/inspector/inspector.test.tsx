import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InspectorTabs, inspectorTabFromSearch } from './index';

const tabs = [
  { id: 'atividade' as const, label: 'Atividade', content: <p>timeline</p> },
  { id: 'mudancas' as const, label: 'Mudanças', content: <p>changes</p> },
];

describe('inspectorTabFromSearch', () => {
  it('accepts known tabs and defaults the rest', () => {
    expect(inspectorTabFromSearch('mudancas')).toBe('mudancas');
    expect(inspectorTabFromSearch('router')).toBe('router');
    expect(inspectorTabFromSearch('nope')).toBe('atividade');
    expect(inspectorTabFromSearch(null)).toBe('atividade');
  });
});

describe('InspectorTabs', () => {
  it('follows the ARIA tabs pattern', () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs activeTab="mudancas" onTabChange={() => {}} tabs={tabs} />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-selected="true"');
  });

  // The brief's original assertion here was `not.toContain('timeline')`, i.e.
  // render only the active panel. That is wrong for this codebase: ChatPane and
  // ModelPinPanel keep pane-local state that resets on unmount, and the preview
  // pane's conversational fallback holds a ref into ChatPane's current closure.
  // Every panel therefore stays mounted and inactive ones are hidden, which
  // also removes them from the accessibility tree.
  it('keeps every panel mounted and hides the inactive ones', () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs activeTab="mudancas" onTabChange={() => {}} tabs={tabs} />,
    );
    expect(markup).toContain('changes');
    expect(markup).toContain('timeline');

    const panels = [...markup.matchAll(/<div role="tabpanel"[^>]*>/g)].map(([tag]) => tag);
    expect(panels).toHaveLength(2);
    expect(panels[0]).toContain('id="inspector-panel-atividade"');
    expect(panels[0]).toContain('hidden=""');
    expect(panels[1]).toContain('id="inspector-panel-mudancas"');
    expect(panels[1]).not.toContain('hidden=""');
  });

  it('marks a tab that needs attention', () => {
    const withBadge = [
      {
        id: 'mudancas' as const,
        label: 'Mudanças',
        badge: { tone: 'warn' as const, count: 1 },
        content: <p>x</p>,
      },
    ];
    const markup = renderToStaticMarkup(
      <InspectorTabs activeTab="mudancas" onTabChange={() => {}} tabs={withBadge} />,
    );
    expect(markup).toContain('data-badge-tone="warn"');
  });
});
