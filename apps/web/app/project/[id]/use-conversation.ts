'use client';

import { useEffect, useState } from 'react';
import type { ConversationPageResponse } from '@agent-foundry/contracts';
import { getConversation } from '../../../lib/api';

/**
 * The conversation poll plus the two derivations the builder page reads from
 * it. Moved verbatim out of `page.tsx` in Task 4b; the effect body, interval
 * and dependency array are unchanged.
 */
export function useConversation(id: string) {
  const [conversation, setConversation] = useState<ConversationPageResponse | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getConversation(id);
        if (active) setConversation(next);
      } catch {
        // conversation panel is best-effort; the main project poll surfaces fatal errors
      }
      timer = setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  // Conversation operations (plan/build sent from the Conversa panel below)
  // each run under their OWN WorkflowRun — a different run than the project's
  // original DAG run. Only the most recently created operation can plausibly
  // still be in flight (operations are processed one at a time), so its own run
  // status — not artifactReferences emptiness — is what "in flight" actually
  // means: a build started from an approved plan inherits the plan's
  // artifactReferences at creation, before its own run ever executes, so
  // emptiness alone would wrongly call it "done" from birth.
  const latestOperation = conversation?.operations.at(-1);

  const latestApprovedPlan = conversation?.operations
    .filter((op) => op.kind === 'plan' && op.approval?.status === 'approved')
    .at(-1);

  return { conversation, setConversation, latestOperation, latestApprovedPlan };
}
