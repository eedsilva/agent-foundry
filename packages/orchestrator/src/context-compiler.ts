import type {
  ChangeRequest,
  ContextSource,
  Message,
  ProjectVersion,
} from '@agent-foundry/contracts';

export interface CompiledContext {
  digest: string;
  sources: ContextSource[];
}

/** ponytail: fixed recency window, revisit with a token budget once real conversations exist. */
const RECENT_CONFIRMED_WINDOW = 5;

export function compileContext(input: {
  message: Message;
  changeRequest?: ChangeRequest | undefined;
  allChangeRequests: ChangeRequest[];
  versions: ProjectVersion[];
}): CompiledContext {
  const currentId = input.changeRequest?.id;
  const others = input.allChangeRequests.filter((cr) => cr.id !== currentId);
  const referencedIds = new Set(input.changeRequest?.referencedDecisionIds ?? []);

  const confirmed = others
    .filter((cr) => cr.status === 'confirmed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentConfirmedIds = new Set(
    confirmed.slice(0, RECENT_CONFIRMED_WINDOW).map((cr) => cr.id),
  );
  const pinned = confirmed.filter(
    (cr) => referencedIds.has(cr.id) || recentConfirmedIds.has(cr.id),
  );

  const unresolved = others.filter((cr) => cr.status === 'proposed');

  const detailedIds = new Set([...pinned, ...unresolved].map((cr) => cr.id));
  const compacted = others.filter((cr) => !detailedIds.has(cr.id));

  const sections: string[] = [];
  const sources: ContextSource[] = [{ type: 'message', id: input.message.id }];

  if (pinned.length) {
    sections.push(
      `## Pinned decisions\n\n${pinned
        .map((cr) => `- [${cr.id}] ${cr.summary} (kind: ${cr.confirmedKind ?? cr.suggestedKind})`)
        .join('\n')}`,
    );
    for (const cr of pinned) sources.push({ type: 'change-request', id: cr.id });
  }
  if (unresolved.length) {
    sections.push(
      `## Unresolved feedback\n\n${unresolved
        .map((cr) => `- [${cr.id}] ${cr.summary} (awaiting confirmation)`)
        .join('\n')}`,
    );
    for (const cr of unresolved) sources.push({ type: 'change-request', id: cr.id });
  }
  if (input.versions.length) {
    sections.push(
      `## Recent versions\n\n${input.versions
        .map((version) => `- [${version.id}] ${version.kind} at ${version.createdAt}`)
        .join('\n')}`,
    );
    for (const version of input.versions) sources.push({ type: 'project-version', id: version.id });
  }
  if (compacted.length) {
    sections.push(
      `## Compacted history\n\n${compacted.map((cr) => `- [${cr.id}] ${cr.summary}`).join('\n')}`,
    );
    for (const cr of compacted) sources.push({ type: 'change-request', id: cr.id });
  }

  return {
    digest: sections.length ? `${sections.join('\n\n')}\n` : '',
    sources,
  };
}
