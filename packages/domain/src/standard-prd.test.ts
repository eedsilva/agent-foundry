import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractEnvelopeRequirements, validateStandardPrd } from './standard-prd.js';

const normativeTemplate = readFileSync(
  new URL('../../../docs/PRD_STANDARD.md', import.meta.url),
  'utf8',
).match(/```md\n([\s\S]+?)\n```/)?.[1];

const sections = [
  'Problem and objective / Problema e objetivo\n\nOrganize personal tasks with a measurable weekly completion view.',
  'Users and roles / Usuários e papéis\n\n- Application Owner: owns all task records.',
  'Scope and non-goals / Escopo e não objetivos\n\n### In scope\n\n- Personal task tracking\n\n### Non-goals\n\n- Collaboration',
  'Primary journeys / Jornadas principais\n\n1. Owner creates a task and sees it in the list.',
  'Screens and states / Telas e estados\n\n### Visual direction / Direção visual\n\n- Tone and audience: focused personal use\n\n### Tasks\n\n- Purpose: manage tasks',
  'Functional requirements / Requisitos funcionais\n\n- **FR-001**: The owner can create a task.',
  'Conceptual data and ownership / Dados conceituais e propriedade\n\n### Task\n\n- Owner: Application Owner\n- Lifecycle and invariants: title is required.',
  'Business rules / Regras de negócio\n\n- **BR-001**: A task belongs to exactly one owner.',
  'Authentication and permissions / Autenticação e permissões\n\n- Owners must authenticate before accessing tasks.',
  'Non-functional requirements / Requisitos não funcionais\n\n- **NFR-001**: The task list is keyboard accessible.',
  'Acceptance criteria / Critérios de aceite\n\n- **AC-001** — Verifies: FR-001, BR-001, NFR-001\n  - Given an authenticated owner\n  - When the owner creates a task\n  - Then the task appears in the owner task list.',
  'Assumptions / Premissas\n\nNone',
  'Open decisions / Decisões em aberto\n\nNone',
];

function section(number: number): { heading: string; content: string } {
  const [heading, content] = sections[number - 1]!.split('\n\n', 2);
  return { heading: heading!, content: content! };
}

function prd(
  overrides: Partial<Record<number, string>> = {},
  order = sections.map((_, index) => index + 1),
) {
  return [
    '# PRD — Task list',
    'PRD Standard: 1',
    'Interface language: pt-BR',
    ...order.flatMap((number) => {
      const current = section(number);
      return ['', `## ${number}. ${current.heading}`, '', overrides[number] ?? current.content];
    }),
  ].join('\n');
}

function completedNormativeTemplate(): string {
  if (!normativeTemplate) throw new Error('PRD Standard template is required for this fixture.');
  return normativeTemplate
    .replace(
      'Interface language: <BCP 47 tag, for example pt-BR or en-US>',
      'Interface language: pt-BR',
    )
    .replace(/<[^>]+>/g, 'concrete product behavior');
}

describe('validateStandardPrd', () => {
  it('returns a versioned canonical representation without model execution', () => {
    const result = validateStandardPrd(prd());

    expect(result).toMatchObject({
      ok: true,
      prd: {
        schemaVersion: '1',
        interfaceLanguage: 'pt-BR',
        identity: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('preserves every non-empty line of a valid document in its canonical markdown', () => {
    const source = prd();
    const result = validateStandardPrd(source);

    if (!result.ok) throw new Error('fixture must be valid');
    const canonicalLines = new Set(result.prd.canonicalMarkdown.split('\n'));
    for (const line of source.split('\n').filter((line) => line.trim())) {
      expect(canonicalLines).toContain(line);
    }
  });

  it('preserves fenced normative-template content in canonical markdown', () => {
    const source = completedNormativeTemplate().replace(
      '\n## 13. Open decisions / Decisões em aberto',
      '\n\n```md\n### Literal subheading\n  - Indented detail\n## 14. Literal example\n```\n\n## 13. Open decisions / Decisões em aberto',
    );
    const result = validateStandardPrd(source);

    if (!result.ok) throw new Error('fixture must be valid');
    const canonicalLines = new Set(result.prd.canonicalMarkdown.split('\n'));
    for (const line of source.split('\n').filter((line) => line.trim())) {
      expect(canonicalLines).toContain(line);
    }
  });

  it('validates the completed normative Standard PRD template', () => {
    expect(validateStandardPrd(completedNormativeTemplate())).toMatchObject({ ok: true });
  });

  it('keeps identity when required sections are reordered', () => {
    const original = validateStandardPrd(prd());
    const reordered = validateStandardPrd(prd({}, [13, 1, 11, 2, 12, 3, 10, 4, 9, 5, 8, 6, 7]));

    expect(original).toMatchObject({ ok: true });
    expect(reordered).toMatchObject({ ok: true });
    if (!original.ok || !reordered.ok) return;
    expect(reordered.prd.identity).toBe(original.prd.identity);
  });

  it('changes identity for a semantic change', () => {
    const original = validateStandardPrd(prd());
    const changed = validateStandardPrd(
      prd({ 6: section(6).content.replace('create a task', 'archive a task') }),
    );

    if (!original.ok || !changed.ok) throw new Error('fixture must be valid');
    expect(changed.prd.identity).not.toBe(original.prd.identity);
  });

  it('reports localized errors for incomplete, duplicate, and invalid deterministic input', () => {
    const incomplete = validateStandardPrd(prd({ 5: '', 10: 'No measurable criterion.' }));
    const duplicate = validateStandardPrd(
      prd({ 8: `${section(8).content}\n\n- **FR-001**: Duplicate.` }),
    );
    const invalid = validateStandardPrd(
      prd({ 11: section(11).content.replace('FR-001, BR-001, NFR-001', 'FR-999') })
        .replace('Interface language: pt-BR', 'Interface language: not a language')
        .replace(
          '## 13. Open decisions / Decisões em aberto\n\nNone',
          '## 13. Open decisions / Decisões em aberto\n\nChoose a database',
        ),
    );

    expect(incomplete).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: 'sections.5' }),
        expect.objectContaining({ code: 'missing-identifier', path: 'sections.10' }),
      ]),
    });
    expect(duplicate).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'duplicate-identifier' })]),
    });
    expect(invalid).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-interface-language' }),
        expect.objectContaining({ code: 'unknown-acceptance-reference' }),
        expect.objectContaining({ code: 'open-decisions' }),
      ]),
    });
  });

  it('blocks placeholders, bare Not applicable, and documents above 50,000 characters', () => {
    const result = validateStandardPrd(
      prd({ 3: `${section(3).content} TODO TBD`, 12: 'Not applicable' }) +
        `\n${'x'.repeat(50_001)}`,
    );

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'max-length' }),
        expect.objectContaining({ code: 'not-applicable-reason' }),
        expect.objectContaining({ code: 'open-placeholder' }),
      ]),
    });
  });

  it('permits Portuguese standard tokens and lowercase ordinary words', () => {
    const result = validateStandardPrd(
      prd({
        3: `${section(3).content}\n\n- O todo usuário vê apenas suas tarefas.`,
        12: 'Não aplicável porque esta primeira versão não integra serviços externos.',
        13: 'nenhuma',
      }),
    );

    expect(result).toMatchObject({ ok: true });
  });

  it('rejects lowercase bare Not applicable', () => {
    const result = validateStandardPrd(prd({ 12: 'not applicable' }));

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'not-applicable-reason' })]),
    });
  });

  it('permits lowercase None', () => {
    expect(validateStandardPrd(prd({ 13: 'none' }))).toMatchObject({ ok: true });
  });

  it('rejects sections outside the template, including identifiers they define', () => {
    expect(validateStandardPrd(prd())).toMatchObject({ ok: true });
    const result = validateStandardPrd(
      `${prd({
        11: section(11).content.replace('NFR-001', 'NFR-001, FR-002'),
      })}\n\n## 14. Unsupported extension\n\n- **FR-002**: This must not satisfy an acceptance criterion.`,
    );

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unknown-section', path: 'sections.14' }),
      ]),
    });
  });

  it('rejects content before section 1 and non-canonical section numbers', () => {
    expect(validateStandardPrd(prd())).toMatchObject({ ok: true });
    const unexpectedContent = validateStandardPrd(
      prd().replace('## 1.', 'Unscoped product prose\n\n## 1.'),
    );
    const leadingZero = validateStandardPrd(prd().replace('## 1.', '## 01.'));

    expect(unexpectedContent).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unexpected-content' })]),
    });
    expect(leadingZero).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid-section-number' })]),
    });
  });

  it.each([
    ['backtick', '```', '```'],
    ['tilde', '~~~', '~~~'],
    ['indented backtick', '  ```', '  ```'],
  ])('rejects a %s fence before section 1 exactly once', (_name, open, close) => {
    const original = prd();
    const withFence = original.replace(
      '## 1.',
      `${open}\n## 14. Cost model\n\nThe customer pays monthly.\n${close}\n\n## 1.`,
    );
    const valid = validateStandardPrd(original);
    const invalid = validateStandardPrd(withFence);

    expect(valid).toMatchObject({ ok: true });
    expect(invalid).toMatchObject({ ok: false });
    if (invalid.ok) return;
    expect(invalid.issues.filter((issue) => issue.code === 'unexpected-content')).toHaveLength(1);
  });

  it('ignores template headings inside a fenced code block', () => {
    expect(
      validateStandardPrd(prd({ 12: `None\n\n\`\`\`md\n${normativeTemplate}\n\`\`\`` })),
    ).toMatchObject({ ok: true });
  });

  it('measures maximum length before whitespace normalization', () => {
    const result = validateStandardPrd(`${prd()}\n${' '.repeat(50_001)}`);
    const crlfResult = validateStandardPrd('\r\n'.repeat(25_001));

    for (const candidate of [result, crlfResult]) {
      expect(candidate).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'max-length' })]),
      });
    }
  });

  it('delimits indented acceptance criteria by their next definition', () => {
    const result = validateStandardPrd(
      prd({
        11: `  - **AC-001** — Verifies: FR-001, BR-001, NFR-001
    - Given an authenticated owner
    - When the owner creates a task
  - **AC-002** — Verifies: FR-001
    - Given an authenticated owner
    - When the owner archives a task
    - Then the task is removed from the active list.`,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-observable-acceptance',
          path: 'acceptance.AC-001',
          message: expect.stringContaining('Then'),
        }),
      ]),
    });
  });

  it('requires identifiers in their required section', () => {
    const result = validateStandardPrd(
      prd({
        6: 'The owner can create a task.',
        8: `${section(8).content}\n- **FR-001**: Defined in the wrong section.`,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'missing-identifier', path: 'sections.6' }),
      ]),
    });
  });
});

describe('extractEnvelopeRequirements', () => {
  it('attaches backticked capability markers to the covering FR/BR/NFR identifier', () => {
    const source = prd({
      6: [
        '- **FR-001**: The owner can create a task. `capability:user-owned-crud`',
        '- **FR-002**: The owner uploads an attachment.',
        '  Stored per task. `capability:file-upload`',
      ].join('\n'),
      8: '- **BR-001**: A task belongs to exactly one owner. `capability:ownership`',
    });

    expect(extractEnvelopeRequirements(source)).toEqual([
      { id: 'FR-001', capability: 'user-owned-crud' },
      { id: 'FR-002', capability: 'file-upload' },
      { id: 'BR-001', capability: 'ownership' },
      { id: 'NFR-001', capability: '' },
    ]);
  });

  it('yields an unattributed requirement for a marker outside any identifier definition', () => {
    const source = prd({
      3: `${section(3).content}\n- Task tracking \`capability:filtering\``,
    });

    expect(extractEnvelopeRequirements(source)).toEqual([
      { id: '', capability: 'filtering' },
      { id: 'FR-001', capability: '' },
      { id: 'BR-001', capability: '' },
      { id: 'NFR-001', capability: '' },
    ]);
  });

  it('resets attribution at section boundaries and ignores fenced code', () => {
    const source = prd({
      6: '- **FR-001**: Create task.\n```\n`capability:payments`\n```',
      7: `${section(7).content}\n- Notes \`capability:domain-entity\``,
    });

    expect(extractEnvelopeRequirements(source)).toEqual([
      { id: 'FR-001', capability: '' },
      { id: '', capability: 'domain-entity' },
      { id: 'BR-001', capability: '' },
      { id: 'NFR-001', capability: '' },
    ]);
  });

  it('emits every unmarked FR/BR/NFR item with an empty capability', () => {
    expect(extractEnvelopeRequirements(prd())).toEqual([
      { id: 'FR-001', capability: '' },
      { id: 'BR-001', capability: '' },
      { id: 'NFR-001', capability: '' },
    ]);
  });

  it('never lets a loose paragraph inherit the previous requirement identifier', () => {
    const source = prd({
      6: [
        '- **FR-001**: Create task. `capability:user-owned-crud`',
        '',
        'A loose paragraph. `capability:filtering`',
      ].join('\n'),
    });

    expect(extractEnvelopeRequirements(source)).toContainEqual({
      id: '',
      capability: 'filtering',
    });
    expect(extractEnvelopeRequirements(source)).not.toContainEqual({
      id: 'FR-001',
      capability: 'filtering',
    });
  });

  it('emits markers with invalid case or syntax verbatim instead of dropping them', () => {
    const source = prd({
      6: [
        '- **FR-001**: Upload. `capability:File-Upload`',
        '- **FR-002**: Sync. `CAPABILITY:realtime`',
      ].join('\n'),
    });

    const extracted = extractEnvelopeRequirements(source);
    expect(extracted).toContainEqual({ id: 'FR-001', capability: 'File-Upload' });
    expect(extracted).toContainEqual({ id: 'FR-002', capability: 'CAPABILITY:realtime' });
  });

  it('does not let an AC marker satisfy the classification of the requirement it verifies', () => {
    const source = prd({
      11: [
        '- **AC-001** — Verifies: FR-001, BR-001, NFR-001 `capability:user-owned-crud`',
        '  - Given an authenticated owner',
        '  - When the owner creates a task',
        '  - Then the task appears in the owner task list.',
      ].join('\n'),
    });

    const extracted = extractEnvelopeRequirements(source);
    expect(extracted).toContainEqual({ id: 'AC-001', capability: 'user-owned-crud' });
    expect(extracted).toContainEqual({ id: 'FR-001', capability: '' });
  });
});
