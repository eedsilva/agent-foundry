'use client';

import { useEffect, useState } from 'react';
import type { ValidationCampaignResponse } from '@agent-foundry/contracts';
import { getValidationCampaign } from '../../lib/api.js';
import { ERROR_BOX } from '@/lib/ui';
import { ValidationCampaignView } from './validation-campaign-view.js';

export default function ValidationCampaignPage() {
  const [response, setResponse] = useState<ValidationCampaignResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getValidationCampaign()
      .then(setResponse)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  if (error)
    return (
      <p role="alert" className={`${ERROR_BOX} m-6`}>
        {error}
      </p>
    );
  if (!response) return <p className="text-ink-muted m-6 text-[13px]">Carregando…</p>;
  return <ValidationCampaignView response={response} />;
}
