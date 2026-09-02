import { createHash } from 'node:crypto';

const REQUIRED_SECTIONS = [
  'Problem and objective / Problema e objetivo',
  'Users and roles / Usuários e papéis',
  'Scope and non-goals / Escopo e não objetivos',
  'Primary journeys / Jornadas principais',
  'Screens and states / Telas e estados',
  'Functional requirements / Requisitos funcionais',
  'Conceptual data and ownership / Dados conceituais e propriedade',
  'Business rules / Regras de negócio',
  'Authentication and permissions / Autenticação e permissões',
  'Non-functional requirements / Requisitos não funcionais',
  'Acceptance criteria / Critérios de aceite',
  'Assumptions / Premissas',
  'Open decisions / Decisões em aberto',
] as const;

const IDENTIFIER_PATTERN = /^(?:FR|BR|NFR|AC)-\d{3}$/;
const IDENTIFIER_DEFINITION = /^\s*-\s+\*\*((?:FR|BR|NFR|AC)-\d{3})\*\*\s*(?::|—)/gm;
const ACCEPTANCE_CRITERION = /^\s*-\s+\*\*(AC-\d{3})\*\*\s+—\s+Verifies:\s*(.+)$/gm;
const NOT_APPLICABLE = new Set(['not applicable', 'não aplicável']);
const NO_OPEN_DECISIONS = new Set(['none', 'nenhuma', 'nenhum']);

export type StandardPrdIssue = {
  code: string;
  path: string;
  message: string;
};

export type StandardPrd = {
  schemaVersion: '1';
  title: string;
  interfaceLanguage: string;
  canonicalMarkdown: string;
  identity: string;
};

export type StandardPrdValidationResult =
  { ok: true; prd: StandardPrd } | { ok: false; issues: StandardPrdIssue[] };

/**
 * Pure deterministic intake validation. Revision persistence and approval are
 * deliberately downstream concerns (#602 and #601 respectively).
 */
export function validateStandardPrd(markdown: string): StandardPrdValidationResult {
  const source = markdown.replace(/\r\n?/g, '\n');
  const document = normalizeDocument(source);
  const issues: StandardPrdIssue[] = [];
  if (markdown.length > 50_000) {
    issues.push({
      code: 'max-length',
      path: 'document',
      message: 'PRD must not exceed 50,000 characters.',
    });
  }
  if (/\b(?:TBD|TODO)\b/.test(document)) {
    issues.push({
      code: 'open-placeholder',
      path: 'document',
      message: 'PRD must not contain TBD or TODO.',
    });
  }

  const lines = document.split('\n');
  const headerLines = stripFencedCode(document).split('\n');
  const title = requiredValue(
    headerLines,
    /^# PRD —\s+(.+)$/,
    'title',
    'PRD title is required.',
    issues,
  );
  const standard = requiredValue(
    headerLines,
    /^PRD Standard:\s*(.+)$/,
    'standard',
    'PRD Standard: 1 is required.',
    issues,
  );
  if (standard && standard !== '1') {
    issues.push({
      code: 'unsupported-standard',
      path: 'standard',
      message: 'PRD Standard must be 1.',
    });
  }
  const language = requiredValue(
    headerLines,
    /^Interface language:\s*(.+)$/,
    'interfaceLanguage',
    'Interface language is required.',
    issues,
  );
  const interfaceLanguage = canonicalLanguage(language, issues);
  const sections = parseSections(lines, issues);

  for (const [index, heading] of REQUIRED_SECTIONS.entries()) {
    const section = sections.get(index + 1);
    const path = `sections.${index + 1}`;
    if (!section) {
      issues.push({
        code: 'missing-section',
        path,
        message: `Missing section ${index + 1}: ${heading}.`,
      });
      continue;
    }
    if (section.heading !== heading) {
      issues.push({
        code: 'invalid-section-heading',
        path,
        message: `Section ${index + 1} must be named ${heading}.`,
      });
    }
    if (!section.content) {
      issues.push({
        code: 'empty-section',
        path,
        message: `Section ${index + 1} must not be empty.`,
      });
    } else if (NOT_APPLICABLE.has(section.content.trim().toLowerCase())) {
      issues.push({
        code: 'not-applicable-reason',
        path,
        message: 'Not applicable must include a reason.',
      });
    }
  }

  const openDecisions = sections.get(13)?.content;
  if (openDecisions && !NO_OPEN_DECISIONS.has(openDecisions.trim().toLowerCase())) {
    issues.push({
      code: 'open-decisions',
      path: 'sections.13',
      message: 'Open decisions must be None before approval.',
    });
  }

  validateIdentifiers(sections, issues);
  if (issues.length > 0) return { ok: false, issues };

  const canonicalMarkdown = [
    `# PRD — ${title!}`,
    'PRD Standard: 1',
    `Interface language: ${interfaceLanguage!}`,
    ...REQUIRED_SECTIONS.flatMap((heading, index) => [
      '',
      `## ${index + 1}. ${heading}`,
      '',
      sections.get(index + 1)!.content,
    ]),
    '',
  ].join('\n');
  return {
    ok: true,
    prd: {
      schemaVersion: '1',
      title: title!,
      interfaceLanguage: interfaceLanguage!,
      canonicalMarkdown,
      identity: createHash('sha256').update(canonicalMarkdown).digest('hex'),
    },
  };
}

/**
 * Identity of a stored PRD Revision (#602): the hash approvals must reference.
 * For a PRD Standard document this equals `validateStandardPrd(...).prd.identity`
 * because the stored content is the canonical markdown itself.
 */
export function prdIdentity(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

const CAPABILITY_MARKER = /`(capability):([^`]*)`/gi;
const REQUIREMENT_LINE = /^\s*-\s+\*\*((?:FR|BR|NFR|AC)-\d{3})\*\*/;

/**
 * Deterministic capability extraction for the Supported Application Envelope
 * (#602). Only explicit backticked `capability:<slug>` markers count — prose
 * is never interpreted. A marker attaches to the requirement bullet only when
 * it sits on the bullet's own line or an indented continuation of it; any
 * non-indented line ends the item, so a marker in a loose paragraph never
 * inherits the previous identifier. Every FR/BR/NFR item is emitted even
 * without markers (empty capability), and a marker whose keyword or slug is
 * not the exact lowercase form is emitted verbatim — the envelope classifier
 * turns both into Blocking Questions instead of letting them disappear.
 */
export function extractEnvelopeRequirements(
  markdown: string,
): Array<{ id: string; capability: string }> {
  const requirements: Array<{ id: string; capability: string }> = [];
  let currentId = '';
  let currentNeedsClassification = false;
  let currentMarkers = 0;
  const closeCurrent = () => {
    if (currentNeedsClassification && currentMarkers === 0) {
      requirements.push({ id: currentId, capability: '' });
    }
    currentId = '';
    currentNeedsClassification = false;
    currentMarkers = 0;
  };
  for (const line of stripFencedCode(normalizeDocument(markdown)).split('\n')) {
    const definition = REQUIREMENT_LINE.exec(line);
    if (definition) {
      closeCurrent();
      currentId = definition[1]!;
      currentNeedsClassification = !currentId.startsWith('AC-');
    } else if (/^\S/.test(line)) {
      closeCurrent();
    }
    for (const match of line.matchAll(CAPABILITY_MARKER)) {
      const keyword = match[1]!;
      const slug = match[2]!;
      if (currentId) currentMarkers += 1;
      requirements.push({
        id: currentId,
        capability: keyword === 'capability' ? slug : `${keyword}:${slug}`,
      });
    }
  }
  closeCurrent();
  return requirements;
}

function normalizeDocument(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function requiredValue(
  lines: string[],
  expression: RegExp,
  path: string,
  message: string,
  issues: StandardPrdIssue[],
): string | undefined {
  const values = lines.flatMap((line) => {
    const match = expression.exec(line);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
  if (values.length !== 1) {
    issues.push({ code: 'missing-or-duplicate-field', path, message });
    return undefined;
  }
  return values[0];
}

function canonicalLanguage(
  value: string | undefined,
  issues: StandardPrdIssue[],
): string | undefined {
  if (!value) return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    issues.push({
      code: 'invalid-interface-language',
      path: 'interfaceLanguage',
      message: 'Interface language must be a valid BCP 47 language tag.',
    });
    return undefined;
  }
}

function parseSections(lines: string[], issues: StandardPrdIssue[]): Map<number, Section> {
  const sections = new Map<number, Section>();
  let current: { number: number; heading: string; lines: string[] } | undefined;
  let fence: '`' | '~' | undefined;
  let sawSection = false;
  let reportedUnexpectedContent = false;
  const finish = () => {
    if (!current) return;
    if (sections.has(current.number)) {
      issues.push({
        code: 'duplicate-section',
        path: `sections.${current.number}`,
        message: `Section ${current.number} is duplicated.`,
      });
    } else {
      sections.set(current.number, {
        heading: current.heading,
        content: current.lines.join('\n').trim(),
      });
    }
  };
  for (const line of lines) {
    const match = /^## ([1-9]\d*)\.\s+(.+)$/.exec(line);
    const nonCanonicalNumber = /^## \d+\.\s+(.+)$/.exec(line);
    if (
      !sawSection &&
      !nonCanonicalNumber &&
      !(match?.[1] === '1') &&
      line.trim() &&
      !isPreambleLine(line)
    ) {
      if (!reportedUnexpectedContent) {
        issues.push({
          code: 'unexpected-content',
          path: 'document',
          message: 'Only the title and header fields may appear before section 1.',
        });
        reportedUnexpectedContent = true;
      }
      continue;
    }
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (delimiter?.[1]![0] === fence) fence = undefined;
      if (current) current.lines.push(line);
      continue;
    }
    if (delimiter) {
      fence = delimiter[1]![0] as '`' | '~';
      if (current) current.lines.push(line);
      continue;
    }

    if (match) {
      finish();
      sawSection = true;
      const number = Number(match[1]);
      if (number > REQUIRED_SECTIONS.length) {
        issues.push({
          code: 'unknown-section',
          path: `sections.${number}`,
          message: `Section ${number} is not part of PRD Standard 1.`,
        });
        current = undefined;
      } else {
        current = { number, heading: match[2]!, lines: [] };
      }
    } else if (nonCanonicalNumber) {
      finish();
      issues.push({
        code: 'invalid-section-number',
        path: 'document',
        message: 'Section numbers must not contain leading zeroes.',
      });
      current = undefined;
    } else if (current) {
      current.lines.push(line);
    }
  }
  finish();
  return sections;
}

function isPreambleLine(line: string): boolean {
  return /^(?:# PRD —|PRD Standard:|Interface language:)/.test(line);
}

function validateIdentifiers(sections: Map<number, Section>, issues: StandardPrdIssue[]): void {
  const identifiers = new Map<string, string>();
  for (const [number, section] of sections) {
    for (const match of stripFencedCode(section.content).matchAll(IDENTIFIER_DEFINITION)) {
      const identifier = match[1]!;
      if (identifiers.has(identifier)) {
        issues.push({
          code: 'duplicate-identifier',
          path: `sections.${number}`,
          message: `${identifier} is already defined in ${identifiers.get(identifier)}.`,
        });
      } else {
        identifiers.set(identifier, `sections.${number}`);
      }
    }
  }
  for (const [section, prefix] of [
    [6, 'FR'],
    [8, 'BR'],
    [10, 'NFR'],
    [11, 'AC'],
  ] as const) {
    const content = stripFencedCode(sections.get(section)?.content ?? '');
    if (
      ![...content.matchAll(IDENTIFIER_DEFINITION)].some((match) =>
        match[1]?.startsWith(`${prefix}-`),
      )
    ) {
      issues.push({
        code: 'missing-identifier',
        path: `sections.${section}`,
        message: `Section ${section} must define at least one ${prefix}-NNN identifier.`,
      });
    }
  }

  const acceptanceCriteria = stripFencedCode(sections.get(11)?.content ?? '');
  const criteria = [...acceptanceCriteria.matchAll(ACCEPTANCE_CRITERION)];
  for (const [index, match] of criteria.entries()) {
    const criterion = match[1]!;
    const references = match[2]!
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (references.length === 0) {
      issues.push({
        code: 'missing-acceptance-reference',
        path: `acceptance.${criterion}`,
        message: `${criterion} must name the requirements it verifies.`,
      });
    }
    for (const reference of references) {
      if (
        !IDENTIFIER_PATTERN.test(reference) ||
        reference.startsWith('AC-') ||
        !identifiers.has(reference)
      ) {
        issues.push({
          code: 'unknown-acceptance-reference',
          path: `acceptance.${criterion}`,
          message: `${criterion} references unknown requirement ${reference}.`,
        });
      }
    }
    const start = match.index! + match[0].length;
    const body = acceptanceCriteria.slice(start, criteria[index + 1]?.index);
    for (const keyword of ['Given', 'When', 'Then']) {
      if (!new RegExp(`^\\s*-\\s*${keyword}\\s+\\S`, 'm').test(body)) {
        issues.push({
          code: 'missing-observable-acceptance',
          path: `acceptance.${criterion}`,
          message: `${criterion} must include ${keyword} with observable content.`,
        });
      }
    }
  }
  for (const identifier of identifiers.keys()) {
    if (!identifier.startsWith('AC-')) continue;
    if (
      !new RegExp(`^\\s*-\\s*\\*\\*${identifier}\\*\\*\\s+—\\s+Verifies:`, 'm').test(
        acceptanceCriteria,
      )
    ) {
      issues.push({
        code: 'missing-acceptance-reference',
        path: `acceptance.${identifier}`,
        message: `${identifier} must name the requirements it verifies.`,
      });
    }
  }
}

function stripFencedCode(content: string): string {
  let fence: '`' | '~' | undefined;
  return content
    .split('\n')
    .flatMap((line) => {
      const delimiter = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (delimiter?.[1]![0] === fence) fence = undefined;
        return [];
      }
      if (delimiter) {
        fence = delimiter[1]![0] as '`' | '~';
        return [];
      }
      return [line];
    })
    .join('\n');
}

type Section = { heading: string; content: string };
