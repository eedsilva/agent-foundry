'use client';

import React from 'react';
import type { ActorRef, ModelDefinition } from '@agent-foundry/contracts';
import { FIELD, LABEL, TEXTAREA } from '@/lib/ui';

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
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={LABEL}>
        Modelo do runtime
        <select className={FIELD} name="modelId" required>
          <option value="">Selecione…</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.provider} / {model.model}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Tipo de ator
        <select className={FIELD} name="actorKind" required defaultValue="user">
          {ACTOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        ID do ator
        <input className={FIELD} name="actorId" required />
      </label>
      <label className={LABEL}>
        Motivo
        <textarea className={`${TEXTAREA} min-h-[84px]`} name="reason" required />
      </label>
      <label className={LABEL}>
        Impacto estimado
        <textarea className={`${TEXTAREA} min-h-[84px]`} name="estimatedImpact" required />
      </label>
    </div>
  );
}
