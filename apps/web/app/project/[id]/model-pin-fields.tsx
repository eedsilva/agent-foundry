'use client';

import React from 'react';
import type { ActorRef, ModelDefinition } from '@agent-foundry/contracts';

const ACTOR_KINDS = ['user', 'system', 'worker', 'provider'] as const;

export function pinFields(data: FormData) {
  return {
    modelId: String(data.get('modelId') ?? ''),
    actorKind: String(data.get('actorKind') ?? 'user') as ActorRef['kind'],
    actorId: String(data.get('actorId') ?? ''),
    reason: String(data.get('reason') ?? ''),
    estimatedImpact: String(data.get('estimatedImpact') ?? ''),
  };
}

export function ModelPinFields({ models }: { models: ModelDefinition[] }) {
  return (
    <div className="modelPinGrid">
      <label>
        Modelo do runtime
        <select name="modelId" required>
          <option value="">Selecione…</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.provider} / {model.model}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tipo de ator
        <select name="actorKind" required defaultValue="user">
          {ACTOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <label>
        ID do ator
        <input name="actorId" required />
      </label>
      <label>
        Motivo
        <textarea className="compactTextarea" name="reason" required />
      </label>
      <label>
        Impacto estimado
        <textarea className="compactTextarea" name="estimatedImpact" required />
      </label>
    </div>
  );
}
