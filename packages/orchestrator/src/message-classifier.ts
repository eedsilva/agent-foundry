import type { ChangeRequest, Message, OperationKind } from '@agent-foundry/contracts';
import { messageText } from './conversation-step-config.js';

export interface ClassificationResult {
  suggestedKind: OperationKind;
  rationale: string;
  referencedDecisionIds: string[];
  summary: string;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'have',
  'has',
  'was',
  'were',
  'are',
  'you',
  'your',
  'let',
  'use',
  'com',
  'que',
  'para',
  'uma',
  'dos',
  'das',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ú\s]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

function summarize(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? text;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

const REPAIR_PATTERN = /\b(fix|bug|error|broken|crash|failing|conserta|corrig|quebrad|erro)\w*/i;
const VISUAL_PATTERN =
  /\b(color|colour|style|css|layout|design|font|spacing|padding|margin|theme|cor|estilo|visual)\w*/i;
const EXPLAIN_PATTERN = /\b(why|what|how|explain|explique|porque|por que|o que|como)\w*/i;
const BUILD_PATTERN =
  /\b(implement|build|add|change|update|create|remove|delete|refactor|write|generate|deploy|implementa|adiciona|muda|mudar|cria|remove|altera|refatora)\w*/i;

function classifyKind(text: string): { kind: OperationKind; rationale: string } {
  if (REPAIR_PATTERN.test(text)) {
    return { kind: 'repair', rationale: 'Message names a bug, error, or fix.' };
  }
  if (VISUAL_PATTERN.test(text)) {
    return { kind: 'visual-edit', rationale: 'Message names a visual or styling change.' };
  }
  if (EXPLAIN_PATTERN.test(text) && text.trim().endsWith('?') && !BUILD_PATTERN.test(text)) {
    return { kind: 'explain', rationale: 'Message is a question with no imperative change verb.' };
  }
  if (BUILD_PATTERN.test(text)) {
    return {
      kind: 'build',
      rationale: 'Message uses an imperative verb requesting a workspace change.',
    };
  }
  return {
    kind: 'plan',
    rationale: 'No clear execution verb found; defaulting to a non-mutating plan.',
  };
}

export function findReferencedDecisions(
  messageWords: Set<string>,
  priorChangeRequests: ChangeRequest[],
): string[] {
  const matches: string[] = [];
  for (const changeRequest of priorChangeRequests) {
    if (changeRequest.status !== 'confirmed') continue;
    const summaryWords = new Set(tokenize(changeRequest.summary));
    let overlap = 0;
    for (const word of summaryWords) {
      if (messageWords.has(word)) overlap += 1;
    }
    if (overlap >= 2) matches.push(changeRequest.id);
  }
  return matches;
}

export function classifyMessage(input: {
  message: Message;
  priorChangeRequests: ChangeRequest[];
}): ClassificationResult {
  const text = messageText(input.message);
  const { kind, rationale } = classifyKind(text);
  const referencedDecisionIds = findReferencedDecisions(
    new Set(tokenize(text)),
    input.priorChangeRequests,
  );
  return { suggestedKind: kind, rationale, referencedDecisionIds, summary: summarize(text) };
}
