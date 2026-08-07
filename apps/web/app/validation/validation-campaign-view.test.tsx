import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ValidationCampaignResponse } from '@agent-foundry/contracts';
import { ValidationCampaignView } from './validation-campaign-view.js';

const unselected: ValidationCampaignResponse = {
  availableCampaigns: ['real-todo-v1'],
  selectedCampaign: null,
  preview: null,
};

const selected: ValidationCampaignResponse = {
  availableCampaigns: ['real-todo-v1'],
  selectedCampaign: 'real-todo-v1',
  preview: {
    schemaVersion: '1',
    id: 'real-todo-v1',
    name: 'Real TODO validation campaign',
    sourceRevision: 'a'.repeat(40),
    allowedModels: [
      { id: 'claude-haiku', provider: 'claude', model: 'haiku' },
      { id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna' },
    ],
    routes: [
      {
        taskKind: 'planning',
        selected: { id: 'claude-haiku', provider: 'claude', model: 'haiku' },
        fallbacks: [],
      },
      {
        taskKind: 'implementation',
        selected: { id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna' },
        fallbacks: [],
      },
      {
        taskKind: 'repair',
        selected: { id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna' },
        fallbacks: [],
      },
      {
        taskKind: 'verification',
        selected: { id: 'claude-haiku', provider: 'claude', model: 'haiku' },
        fallbacks: [],
      },
    ],
    limits: {
      attemptsPerAgentStep: 1,
      targetedRepairs: 1,
      activeTimeMinutes: 45,
      meteredCostUsd: 2,
    },
  },
};

describe('ValidationCampaignView', () => {
  it('explains how to opt in without presenting the campaign as the default', () => {
    const markup = renderToStaticMarkup(<ValidationCampaignView response={unselected} />);
    expect(markup).toContain('VALIDATION_CAMPAIGN=real-todo-v1');
    expect(markup).toContain('não está selecionada');
    expect(markup).toContain('fluxo normal');
  });

  it('renders the source, restricted models, routes, and limits before execution', () => {
    const markup = renderToStaticMarkup(<ValidationCampaignView response={selected} />);
    expect(markup).toContain('a'.repeat(40));
    expect(markup).toContain('gpt-5.6-luna');
    expect(markup).toContain('planning');
    expect(markup).toContain('verification');
    expect(markup).toContain('Rotas planejadas');
    expect(markup).toContain('Fallback planejado');
    expect(markup).toContain('45 min');
    expect(markup).not.toContain('US$');
    expect(markup).toContain('Haiku');
    expect(markup).not.toContain('claude-opus');
  });
});
