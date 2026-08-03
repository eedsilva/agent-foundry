import React from 'react';
import type { ValidationCampaignResponse, ValidationModelIdentity } from '@agent-foundry/contracts';
import { HINT, LABEL, META, PAGE, PANEL, PANEL_TITLE, WARN_BOX } from '@/lib/ui';

interface ValidationCampaignViewProps {
  response: ValidationCampaignResponse;
}

export function ValidationCampaignView({ response }: ValidationCampaignViewProps) {
  const preview = response.preview;

  return (
    <div className={PAGE}>
      <header className="mb-8 max-w-[72ch]">
        <p className={HINT}>REAL-MODE / OPERATOR PREVIEW</p>
        <h1 className="text-ink mt-2 text-[32px] leading-tight font-semibold tracking-[-0.02em]">
          Campanha de validação TODO
        </h1>
        <p className={`${META} mt-3`}>
          Uma rota isolada e limitada para diagnóstico. A campanha não altera o fluxo normal da
          aplicação e nenhuma etapa de modelo começa nesta tela.
        </p>
      </header>

      {!preview ? <UnselectedCampaign /> : <SelectedCampaign preview={preview} />}
    </div>
  );
}

function UnselectedCampaign() {
  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>Campanha não está selecionada</h2>
      <p className={`${META} mt-3`}>
        Para selecionar explicitamente a campanha, reinicie API e worker com:
      </p>
      <code className="bg-surface-sunken text-ink mt-3 block overflow-x-auto rounded-card p-3 font-mono text-[12.5px]">
        VALIDATION_CAMPAIGN=real-todo-v1 EXECUTOR_MODE=real
      </code>
      <p className={`${META} mt-3`}>
        Deixe <code>VALIDATION_CAMPAIGN</code> vazio para manter o fluxo normal; a seleção exige
        modo real e falha antes de qualquer chamada quando uma identidade esperada não confere.
      </p>
    </section>
  );
}

function SelectedCampaign({
  preview,
}: {
  preview: NonNullable<ValidationCampaignResponse['preview']>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className={WARN_BOX} role="status">
        Selecionada para inspeção: execução permanece bloqueada até as próximas etapas da campanha.
      </p>

      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>Fonte e catálogo permitido</h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]">
          <dt className={LABEL}>Revisão da fonte</dt>
          <dd className="text-ink m-0 break-all font-mono text-[12px]">{preview.sourceRevision}</dd>
          <dt className={LABEL}>Campanha</dt>
          <dd className="text-ink m-0 font-mono text-[12px]">{preview.id}</dd>
        </dl>
        <div className="border-hairline mt-4 overflow-x-auto rounded-card border">
          <table className="text-ink w-full border-collapse text-left text-[13px]">
            <thead className="bg-surface-sunken">
              <tr>
                <th scope="col" className="p-3 font-semibold">
                  Identidade
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Provider
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Modelo
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.allowedModels.map((model) => (
                <ModelRow key={model.id} model={model} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>Rotas automáticas</h2>
        <div className="border-hairline mt-4 overflow-x-auto rounded-card border">
          <table className="text-ink w-full border-collapse text-left text-[13px]">
            <thead className="bg-surface-sunken">
              <tr>
                <th scope="col" className="p-3 font-semibold">
                  Task kind
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Selecionado
                </th>
                <th scope="col" className="p-3 font-semibold">
                  Fallback automático
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.routes.map((route) => (
                <tr key={route.taskKind} className="border-hairline border-t">
                  <td className="p-3 font-mono text-[12px]">{route.taskKind}</td>
                  <td className="p-3">{modelLabel(route.selected)}</td>
                  <td className="p-3">
                    {route.fallbacks.length ? route.fallbacks.map(modelLabel).join(', ') : 'Nenhum'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>Limites da campanha</h2>
        <ul className={`${META} mt-4 grid gap-2 sm:grid-cols-2`}>
          <li>{preview.limits.attemptsPerAgentStep} tentativa por etapa de agente</li>
          <li>{preview.limits.targetedRepairs} reparo direcionado</li>
          <li>{preview.limits.activeTimeMinutes} min de tempo ativo</li>
          <li>US$ {preview.limits.meteredCostUsd} de custo medido</li>
        </ul>
      </section>
    </div>
  );
}

function ModelRow({ model }: { model: ValidationModelIdentity }) {
  return (
    <tr className="border-hairline border-t">
      <td className="p-3 font-mono text-[12px]">{modelLabel(model)}</td>
      <td className="p-3">{model.provider}</td>
      <td className="p-3 font-mono text-[12px]">{model.model}</td>
    </tr>
  );
}

function modelLabel(model: ValidationModelIdentity): string {
  if (model.id === 'claude-haiku') return 'Claude Haiku';
  if (model.id === 'codex-default') return 'Codex GPT-5.6 Luna';
  return `Local · ${model.id}`;
}
