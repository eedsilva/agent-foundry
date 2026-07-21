import type { AgentStep, Message, VisualEdit } from '@agent-foundry/contracts';
import { ValidationError } from '@agent-foundry/domain';

export const CONVERSATION_WORKFLOW_ID: Record<'plan' | 'build' | 'visual-edit', string> = {
  plan: 'conversation-plan',
  build: 'conversation-build',
  'visual-edit': 'conversation-visual-edit',
};

const STEP_BASE: Record<
  'plan' | 'build' | 'visual-edit',
  Omit<AgentStep, 'id' | 'instructions'>
> = {
  plan: {
    type: 'agent',
    role: 'planner',
    taskKind: 'planning',
    title: 'Chat plan proposal',
    outputArtifact: 'plan-proposal',
    inputArtifacts: [],
    mutatesWorkspace: false,
    harnessTags: [],
    profile: {},
    maxAttempts: 2,
  },
  build: {
    type: 'agent',
    role: 'developer',
    taskKind: 'implementation',
    title: 'Chat build execution',
    outputArtifact: 'build-report',
    inputArtifacts: [],
    mutatesWorkspace: true,
    harnessTags: [],
    profile: {},
    maxAttempts: 2,
  },
  'visual-edit': {
    type: 'agent',
    role: 'planner',
    taskKind: 'planning',
    title: 'Clarify visual edit',
    outputArtifact: 'visual-edit-clarification',
    inputArtifacts: [],
    mutatesWorkspace: false,
    harnessTags: [],
    profile: {},
    maxAttempts: 1,
  },
};

const DIRECT_VISUAL_EDIT_BASE: Omit<AgentStep, 'id' | 'instructions'> = {
  ...STEP_BASE.build,
  title: 'Apply direct visual edit',
  outputArtifact: 'visual-edit-report',
  maxAttempts: 1,
};

function isTextBlock(
  block: Message['content'][number],
): block is Extract<Message['content'][number], { type: 'text' }> {
  return block.type === 'text';
}

export function messageText(message: Message): string {
  const text = message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n\n');
  if (!text) throw new ValidationError(`Message ${message.id} has no text content to act on`);
  return text;
}

export function buildConversationStep(input: {
  operationId: string;
  kind: 'plan' | 'build' | 'visual-edit';
  message: Message;
  visualEdit?: VisualEdit | undefined;
  planArtifact?: { content: unknown } | undefined;
  contextDigest?: string | undefined;
}): AgentStep {
  const base = input.visualEdit ? DIRECT_VISUAL_EDIT_BASE : STEP_BASE[input.kind];
  const planSection = input.planArtifact
    ? `\n\n## Approved plan\n\n\`\`\`json\n${JSON.stringify(input.planArtifact.content, null, 2)}\n\`\`\`\n`
    : '';
  const contextSection = input.contextDigest ? `\n\n${input.contextDigest}` : '';
  return {
    ...base,
    id: `conversation-${input.kind}-${input.operationId}`,
    instructions: input.visualEdit
      ? directVisualEditInstructions(input.visualEdit, contextSection)
      : `${input.kind === 'visual-edit' ? 'Clarify the requested visual change without modifying the workspace until a validated direct patch is supplied.\n\n' : ''}${messageText(input.message)}${contextSection}${planSection}`,
  };
}

function directVisualEditInstructions(edit: VisualEdit, contextSection: string): string {
  return `Apply exactly this validated visual edit patch to the named source target (${edit.target.file}). Preserve the project's existing Tailwind classes, CSS custom properties, and design-token usage; do not replace them with unrelated raw values.\n\n\`\`\`json\n${JSON.stringify(edit, null, 2)}\n\`\`\`${contextSection}`;
}
