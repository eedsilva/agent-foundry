'use client';

import { useEffect, useState } from 'react';
import type { AgentStreamEvent } from '@agent-foundry/contracts';
import { runEventsStreamUrl } from '../../../lib/api';
import { mergeStreamEvents } from '../../../lib/agent-stream';

/**
 * The agent event stream subscription and the per-run reset that guards it.
 * Moved verbatim out of `page.tsx` in Task 4b.
 */
export function useAgentStream(activeOperationRunId: string | undefined) {
  const [streamEvents, setStreamEvents] = useState<AgentStreamEvent[]>([]);
  const [streamEventsRunId, setStreamEventsRunId] = useState<string | undefined>(undefined);

  // `sequence` is scoped per-run, so events from a new run must not be merged
  // against a previous run's — adjusting state during render (React's
  // documented pattern for "reset state when a prop changes") rather than in
  // the effect below, which must only ever subscribe/unsubscribe.
  if (activeOperationRunId !== streamEventsRunId) {
    setStreamEventsRunId(activeOperationRunId);
    setStreamEvents([]);
  }

  useEffect(() => {
    if (!activeOperationRunId) return;
    const source = new EventSource(runEventsStreamUrl(activeOperationRunId), {
      withCredentials: true,
    });
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AgentStreamEvent;
        setStreamEvents((current) => mergeStreamEvents(current, [event]));
      } catch {
        // Malformed frame; drop it silently.
      }
    };
    return () => source.close();
  }, [activeOperationRunId]);

  return { streamEvents };
}
