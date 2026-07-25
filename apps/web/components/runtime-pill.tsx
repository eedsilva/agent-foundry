'use client';

import React, { useEffect, useState } from 'react';
import type { RuntimeInfoResponse } from '@agent-foundry/contracts';
import { getRuntime } from '@/lib/api';
import { cn } from '@/lib/utils';

export function RuntimePill() {
  const [runtime, setRuntime] = useState<RuntimeInfoResponse | null>(null);

  useEffect(() => {
    void getRuntime()
      .then(setRuntime)
      .catch(() => setRuntime(null));
  }, []);

  const live = runtime?.executorMode === 'real';

  return (
    <span
      data-testid="runtime-pill"
      title={runtime ? `${runtime.executors.length} executores` : 'conectando'}
      className="border-hairline text-ink-muted inline-flex items-center gap-2 rounded-full border bg-surface/60 px-3 py-1.5 font-mono text-[12px]"
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', live ? 'bg-ok' : 'bg-ink-subtle')} />
      {runtime ? `${runtime.executorMode} · ${runtime.models.length} modelos` : 'conectando…'}
    </span>
  );
}
