import type { AgentStep, Message } from '@agent-foundry/contracts';
import { ValidationError } from '@agent-foundry/domain';

export const CONVERSATION_WORKFLOW_ID: Record<'plan' | 'build', string> = {
  plan: 'conversation-plan',
  build: 'conversation-build',
};

const STEP_BASE: Record<'plan' | 'build', Omit<AgentStep, 'id' | 'instructions'>> = {
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
  kind: 'plan' | 'build';
  message: Message;
  planArtifact?: { content: unknown } | undefined;
}): AgentStep {
  const base = STEP_BASE[input.kind];
  const planSection = input.planArtifact
    ? `\n\n## Approved plan\n\n\`\`\`json\n${JSON.stringify(input.planArtifact.content, null, 2)}\n\`\`\`\n`
    : '';
  return {
    ...base,
    id: `conversation-${input.kind}-${input.operationId}`,
    instructions: `${messageText(input.message)}${planSection}`,
  };
}
