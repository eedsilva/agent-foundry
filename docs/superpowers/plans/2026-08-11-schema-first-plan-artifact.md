# Schema-First Plan Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a schema-first, operator-reviewable plan artifact (tables, columns, constraints, indexes, per-table RLS policies) — contract, validation, review-surface rendering, and fixtures for the 3 HA-0.1 app shapes — per ADR 0060 and GitHub issue #480.

**Architecture:** Mirror the existing `TaskGraphSchema` pattern in `packages/contracts/src/plan.ts` exactly: one new Zod contract module (`schema-plan.ts`) with a `superRefine`-based referential-integrity check (duplicate table names, unknown local foreign-key references, unknown constraint columns), wrapped in the existing `AgentArtifactSchema` envelope. Wire it into the same two orchestrator seams that already gate `task-graph` output (`workflow-orchestrator.ts`'s `outputSchema` selection and post-execution validation), add a render branch to the existing artifact viewer dialog, and author fixtures for the three HA-0.1 shapes (crud-heavy, dashboard-heavy, auth-heavy) derived from their existing PRDs.

**Tech Stack:** TypeScript, Zod v4 (`z.looseObject`, `z.discriminatedUnion`, `z.toJSONSchema`), Vitest, React (artifact viewer dialog uses `renderToStaticMarkup` for tests, no jsdom).

## Global Constraints

- Every table in the artifact must declare RLS explicitly — validation rejects a table without at least one RLS policy. (Issue #480 agent guidance.)
- Constraints must be expressed in DB terms (primary key / unique / foreign key / check), not app-level validation prose. (Issue #480 acceptance criteria.)
- The destructive-migration approval gate (`packages/platform/src/supabase-runtime.ts` `requireMigrationApproval`) is untouched by this plan — do not modify it. (ADR 0060, issue #480 agent guidance.)
- Contract versioning is forward-only with lenient parsing for stored artifacts: use `z.looseObject` (not `.strict()`) at the top level and `schemaVersion: z.literal('1')`, mirroring `packages/contracts/src/plan.ts`. Do not invent a second "Generated" strict schema variant — there is no legacy schema-plan data to bridge, so a single schema is correct (see Task 1). (Issue #480 agent guidance, ADR 0056 precedent.)
- Migration generation from this artifact is explicitly out of scope (issue #481). Do not generate SQL migrations in this plan.
- Run `tsc -b --pretty false` after every task that touches `.ts`/`.tsx` files (contracts, orchestrator, web app changes all qualify).
- No comments explaining WHAT code does — only WHY, and only when non-obvious. Default to no comments.
- Fast test loop: `npx vitest run <file>` for the specific file(s) a task touches. Do not run the full `npm run test:unit:fast` after every step — only after each task's implementation is complete.

---

### Task 1: Schema-plan contract — tables, columns, constraints, indexes, RLS

**Files:**
- Create: `packages/contracts/src/schema-plan.ts`
- Create: `packages/contracts/src/schema-plan.test.ts`
- Modify: `packages/contracts/src/index.ts` (add one export line)

**Interfaces:**
- Consumes: `AgentArtifactSchema` from `./agent.js`, `PathSegmentSchema` from `./primitives.js` (both already exist, read-only).
- Produces (used by Tasks 2, 3, 4):
  - `ColumnTypeSchema`, `SchemaColumnSchema`, `SchemaConstraintSchema`, `SchemaIndexSchema`, `RlsCommandSchema`, `RlsPolicySchema`, `TableRlsSchema`, `SchemaTableSchema` — building-block Zod schemas.
  - `SchemaPlanSchema: ZodType<SchemaPlan>` where `SchemaPlan = { schemaVersion: '1'; tables: SchemaTable[] }` (plus any extra loose keys).
  - `SchemaPlanArtifactSchema: ZodType<SchemaPlanArtifact>` — `AgentArtifactSchema` with `data: SchemaPlanSchema`.
  - `SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA` — a plain object with `.$id` matching `/schema-plan-artifact-v1/` and an `'x-agent-foundry-runtime-validation'` key.
  - TypeScript types: `SchemaColumn`, `SchemaConstraint`, `SchemaIndex`, `RlsPolicy`, `TableRls`, `SchemaTable`, `SchemaPlan`, `SchemaPlanArtifact`.

- [ ] **Step 1: Write the failing test file**

Create `packages/contracts/src/schema-plan.test.ts` with this exact content:

```typescript
import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import {
  SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA,
  SchemaPlanArtifactSchema,
  SchemaPlanSchema,
} from './schema-plan.js';

const validTable = {
  name: 'categories',
  columns: [
    { name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
    { name: 'name', type: 'text', nullable: false },
  ],
  constraints: [{ type: 'primary-key', columns: ['id'] }],
  indexes: [],
  rls: {
    enabled: true,
    policies: [
      { name: 'authenticated_all', command: 'all', using: "auth.role() = 'authenticated'" },
    ],
  },
};

const plan = {
  schemaVersion: '1' as const,
  tables: [validTable],
};

describe('schema plan contracts', () => {
  it('exports the schema plan schemas', () => {
    expect('SchemaPlanSchema' in contracts).toBe(true);
    expect('SchemaPlanArtifactSchema' in contracts).toBe(true);
    expect('SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA' in contracts).toBe(true);
  });

  it('accepts a valid schema plan', () => {
    expect(SchemaPlanSchema.parse(plan)).toMatchObject({
      tables: [{ name: 'categories' }],
    });
  });

  it('rejects a table with no RLS declared', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [{ ...validTable, rls: undefined }],
      }),
    ).toThrow();
  });

  it('rejects a table with RLS enabled but zero policies', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [{ ...validTable, rls: { enabled: true, policies: [] } }],
      }),
    ).toThrow();
  });

  it('rejects a policy with neither using nor withCheck', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [
          {
            ...validTable,
            rls: { enabled: true, policies: [{ name: 'empty', command: 'select' }] },
          },
        ],
      }),
    ).toThrow(/using and\/or withCheck/);
  });

  it('rejects a duplicate table name', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [validTable, validTable],
      }),
    ).toThrow(/Duplicate table name categories/);
  });

  it('rejects a foreign key referencing an unknown local table', () => {
    const items = {
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'category_id', type: 'uuid', nullable: false },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        {
          type: 'foreign-key',
          columns: ['category_id'],
          referencesTable: 'categories_missing',
          referencesColumns: ['id'],
        },
      ],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    };
    expect(() =>
      SchemaPlanSchema.parse({ schemaVersion: '1', tables: [validTable, items] }),
    ).toThrow(/references unknown table categories_missing/);
  });

  it('allows a foreign key referencing a schema-qualified table outside the artifact', () => {
    const stockAdjustments = {
      name: 'stock_adjustments',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'created_by', type: 'uuid', nullable: false },
      ],
      constraints: [
        { type: 'primary-key', columns: ['id'] },
        {
          type: 'foreign-key',
          columns: ['created_by'],
          referencesTable: 'auth.users',
          referencesColumns: ['id'],
        },
      ],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    };
    expect(
      SchemaPlanSchema.parse({ schemaVersion: '1', tables: [stockAdjustments] }).tables[0]
        ?.constraints,
    ).toHaveLength(2);
  });

  it('rejects a constraint referencing an unknown column', () => {
    expect(() =>
      SchemaPlanSchema.parse({
        schemaVersion: '1',
        tables: [
          { ...validTable, constraints: [{ type: 'primary-key', columns: ['missing_column'] }] },
        ],
      }),
    ).toThrow(/references unknown column missing_column/);
  });

  it('rejects an empty table list and a wrong schema version', () => {
    expect(() => SchemaPlanSchema.parse({ schemaVersion: '1', tables: [] })).toThrow();
    expect(() => SchemaPlanSchema.parse({ ...plan, schemaVersion: '2' })).toThrow();
  });

  it('caps the plan at 100 tables', () => {
    const tables = Array.from({ length: 101 }, (_, index) => ({
      ...validTable,
      name: `t${index}`,
    }));
    expect(() => SchemaPlanSchema.parse({ schemaVersion: '1', tables })).toThrow();
    expect(
      SchemaPlanSchema.parse({ schemaVersion: '1', tables: tables.slice(0, 100) }).tables,
    ).toHaveLength(100);
  });

  it('wraps the plan in the agent artifact envelope', () => {
    expect(
      SchemaPlanArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the schema.',
        data: plan,
      }).data.tables,
    ).toHaveLength(1);
    expect(() =>
      SchemaPlanArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the schema.',
        data: { note: 'prose instead of a schema plan' },
      }),
    ).toThrow();
  });

  it('publishes a model-facing JSON schema with the runtime validation marker', () => {
    expect(SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA.$id).toMatch(/schema-plan-artifact-v1/);
    expect(SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA['x-agent-foundry-runtime-validation']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/schema-plan.test.ts`
Expected: FAIL — `schema-plan.js` module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/contracts/src/schema-plan.ts` with this exact content:

```typescript
import { z } from 'zod';
import { AgentArtifactSchema } from './agent.js';
import { PathSegmentSchema } from './primitives.js';

/** Postgres column types the generator may emit. */
export const ColumnTypeSchema = z.enum([
  'uuid',
  'text',
  'integer',
  'numeric',
  'boolean',
  'timestamptz',
  'date',
  'jsonb',
]);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export const SchemaColumnSchema = z
  .object({
    name: PathSegmentSchema,
    type: ColumnTypeSchema,
    nullable: z.boolean().default(false),
    default: z.string().optional(),
  })
  .strict();
export type SchemaColumn = z.infer<typeof SchemaColumnSchema>;

export const ForeignKeyActionSchema = z.enum(['cascade', 'restrict', 'set-null']);
export type ForeignKeyAction = z.infer<typeof ForeignKeyActionSchema>;

export const SchemaConstraintSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('primary-key'), columns: z.array(PathSegmentSchema).min(1) })
    .strict(),
  z.object({ type: z.literal('unique'), columns: z.array(PathSegmentSchema).min(1) }).strict(),
  z
    .object({
      type: z.literal('foreign-key'),
      columns: z.array(PathSegmentSchema).min(1),
      referencesTable: PathSegmentSchema,
      referencesColumns: z.array(PathSegmentSchema).min(1),
      onDelete: ForeignKeyActionSchema.default('restrict'),
    })
    .strict(),
  z
    .object({ type: z.literal('check'), name: PathSegmentSchema, expression: z.string().min(1) })
    .strict(),
]);
export type SchemaConstraint = z.infer<typeof SchemaConstraintSchema>;

export const SchemaIndexSchema = z
  .object({
    name: PathSegmentSchema,
    columns: z.array(PathSegmentSchema).min(1),
    unique: z.boolean().default(false),
  })
  .strict();
export type SchemaIndex = z.infer<typeof SchemaIndexSchema>;

export const RlsCommandSchema = z.enum(['select', 'insert', 'update', 'delete', 'all']);
export type RlsCommand = z.infer<typeof RlsCommandSchema>;

export const RlsPolicySchema = z
  .object({
    name: PathSegmentSchema,
    command: RlsCommandSchema,
    using: z.string().min(1).optional(),
    withCheck: z.string().min(1).optional(),
  })
  .strict()
  .refine((policy) => policy.using !== undefined || policy.withCheck !== undefined, {
    message: 'RLS policy must declare using and/or withCheck',
  });
export type RlsPolicy = z.infer<typeof RlsPolicySchema>;

export const TableRlsSchema = z
  .object({
    enabled: z.literal(true),
    policies: z.array(RlsPolicySchema).min(1),
  })
  .strict();
export type TableRls = z.infer<typeof TableRlsSchema>;

export const SchemaTableSchema = z
  .object({
    name: PathSegmentSchema,
    columns: z.array(SchemaColumnSchema).min(1),
    constraints: z.array(SchemaConstraintSchema).default([]),
    indexes: z.array(SchemaIndexSchema).default([]),
    rls: TableRlsSchema,
  })
  .strict();
export type SchemaTable = z.infer<typeof SchemaTableSchema>;

type TableForValidation = {
  name: string;
  columns: { name: string }[];
  constraints: SchemaConstraint[];
};

function validateSchemaPlan(tables: readonly TableForValidation[], ctx: z.RefinementCtx): void {
  const tableNames = new Set<string>();
  for (const [index, table] of tables.entries()) {
    if (tableNames.has(table.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tables', index, 'name'],
        message: `Duplicate table name ${table.name}`,
      });
    }
    tableNames.add(table.name);
  }
  for (const [index, table] of tables.entries()) {
    const columnNames = new Set(table.columns.map((column) => column.name));
    for (const [constraintIndex, constraint] of table.constraints.entries()) {
      // A dotted reference (e.g. auth.users) points outside this artifact's
      // tables — Supabase's built-in auth schema is not modeled here.
      if (
        constraint.type === 'foreign-key' &&
        !constraint.referencesTable.includes('.') &&
        !tableNames.has(constraint.referencesTable)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['tables', index, 'constraints', constraintIndex, 'referencesTable'],
          message: `Table ${table.name} references unknown table ${constraint.referencesTable}`,
        });
      }
      const columns = constraint.type === 'check' ? [] : constraint.columns;
      for (const column of columns) {
        if (!columnNames.has(column)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tables', index, 'constraints', constraintIndex, 'columns'],
            message: `Table ${table.name} constraint references unknown column ${column}`,
          });
        }
      }
    }
  }
}

// Loose: forward-only versioning per ADR 0056 — future optional fields must
// not break parsing of already-persisted schema plans.
export const SchemaPlanSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    tables: z.array(SchemaTableSchema).min(1).max(100),
  })
  .superRefine((plan, ctx) => {
    validateSchemaPlan(plan.tables as TableForValidation[], ctx);
  });
export type SchemaPlan = z.infer<typeof SchemaPlanSchema>;

export const SchemaPlanArtifactSchema = AgentArtifactSchema.extend({
  data: SchemaPlanSchema,
});
export type SchemaPlanArtifact = z.infer<typeof SchemaPlanArtifactSchema>;

export const SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/schema-plan-artifact-v1.json',
  ...z.toJSONSchema(SchemaPlanArtifactSchema),
  'x-agent-foundry-runtime-validation': {
    tableReferentialIntegrity: {
      path: 'data.tables[*]',
      enforcedBy: 'SchemaPlanArtifactSchema',
      description:
        'Standard JSON Schema cannot express referential integrity or per-table completeness; the runtime Zod parse rejects duplicate table names, foreign keys referencing unknown local tables or columns, and any table missing an explicit RLS policy.',
    },
  },
};
```

- [ ] **Step 4: Add the export to the contracts package index**

In `packages/contracts/src/index.ts`, add a line right after `export * from './plan.js';` (line 8):

```typescript
export * from './schema-plan.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/schema-plan.test.ts`
Expected: PASS, all 13 tests green.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: no errors. If `plan.tables as TableForValidation[]` is flagged as an unnecessary/unsafe cast, keep it anyway — it mirrors the identical cast in `packages/contracts/src/plan.ts`'s `validateTaskGraph` call and protects against `z.looseObject`'s inferred type not narrowing exactly.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/schema-plan.ts packages/contracts/src/schema-plan.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add schema-first plan artifact contract (#480)"
```

---

### Task 2: HA-0.1 fixtures — crud-heavy, dashboard-heavy, auth-heavy

**Files:**
- Create: `docs/evidence/harness-alignment/crud-heavy/schema-plan.json`
- Create: `docs/evidence/harness-alignment/dashboard-heavy/schema-plan.json`
- Create: `docs/evidence/harness-alignment/auth-heavy/schema-plan.json`
- Create: `packages/contracts/src/schema-plan-fixtures.test.ts`

**Interfaces:**
- Consumes: `SchemaPlanSchema` from `./schema-plan.js` (Task 1).
- Produces: nothing new consumed by later tasks — these are terminal fixtures.

These fixtures are hand-derived from the existing PRDs at `docs/evidence/harness-alignment/{crud-heavy,dashboard-heavy,auth-heavy}/prd.md` (their `## Entities` and, for auth-heavy, `## RLS requirement` sections). Read those three PRD files first so the shape of each fixture makes sense, but use the exact JSON below verbatim — do not redesign the tables.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/schema-plan-fixtures.test.ts` with this exact content:

```typescript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaPlanSchema } from './schema-plan.js';

async function readFixture(shape: string) {
  const path = resolve(
    import.meta.dirname,
    `../../../docs/evidence/harness-alignment/${shape}/schema-plan.json`,
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

function expectEveryTableHasRls(plan: { tables: { rls: { enabled: boolean; policies: unknown[] } }[] }) {
  for (const table of plan.tables) {
    expect(table.rls.enabled).toBe(true);
    expect(table.rls.policies.length).toBeGreaterThan(0);
  }
}

describe('HA-0.1 schema plan fixtures (#480)', () => {
  it('validates the crud-heavy shape schema plan', async () => {
    const plan = SchemaPlanSchema.parse(await readFixture('crud-heavy'));
    expect(plan.tables.map((table) => table.name)).toEqual([
      'categories',
      'items',
      'stock_adjustments',
    ]);
    expectEveryTableHasRls(plan);
  });

  it('validates the dashboard-heavy shape schema plan', async () => {
    const plan = SchemaPlanSchema.parse(await readFixture('dashboard-heavy'));
    expect(plan.tables.map((table) => table.name)).toEqual(['sale_events']);
    expectEveryTableHasRls(plan);
  });

  it('validates the auth-heavy shape schema plan', async () => {
    const plan = SchemaPlanSchema.parse(await readFixture('auth-heavy'));
    expect(plan.tables.map((table) => table.name)).toEqual(['profiles']);
    expectEveryTableHasRls(plan);
    const profiles = plan.tables[0];
    if (!profiles) throw new Error('expected a profiles table');
    // RLS requirement from the PRD: member self-access + admin all-access,
    // both select and update.
    expect(profiles.rls.policies.map((policy) => policy.command).sort()).toEqual([
      'select',
      'select',
      'update',
      'update',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/schema-plan-fixtures.test.ts`
Expected: FAIL — fixture files don't exist yet (ENOENT).

- [ ] **Step 3: Create the crud-heavy fixture**

Create `docs/evidence/harness-alignment/crud-heavy/schema-plan.json` with this exact content:

```json
{
  "schemaVersion": "1",
  "tables": [
    {
      "name": "categories",
      "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "name", "type": "text", "nullable": false },
        { "name": "description", "type": "text", "nullable": true }
      ],
      "constraints": [{ "type": "primary-key", "columns": ["id"] }],
      "indexes": [],
      "rls": {
        "enabled": true,
        "policies": [
          {
            "name": "authenticated_all",
            "command": "all",
            "using": "auth.role() = 'authenticated'",
            "withCheck": "auth.role() = 'authenticated'"
          }
        ]
      }
    },
    {
      "name": "items",
      "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "name", "type": "text", "nullable": false },
        { "name": "sku", "type": "text", "nullable": false },
        { "name": "category_id", "type": "uuid", "nullable": false },
        { "name": "quantity", "type": "integer", "nullable": false, "default": "0" },
        { "name": "reorder_threshold", "type": "integer", "nullable": false, "default": "0" }
      ],
      "constraints": [
        { "type": "primary-key", "columns": ["id"] },
        { "type": "unique", "columns": ["sku"] },
        {
          "type": "foreign-key",
          "columns": ["category_id"],
          "referencesTable": "categories",
          "referencesColumns": ["id"],
          "onDelete": "restrict"
        },
        { "type": "check", "name": "items_quantity_non_negative", "expression": "quantity >= 0" },
        {
          "type": "check",
          "name": "items_reorder_threshold_non_negative",
          "expression": "reorder_threshold >= 0"
        }
      ],
      "indexes": [
        { "name": "items_category_id_idx", "columns": ["category_id"], "unique": false }
      ],
      "rls": {
        "enabled": true,
        "policies": [
          {
            "name": "authenticated_all",
            "command": "all",
            "using": "auth.role() = 'authenticated'",
            "withCheck": "auth.role() = 'authenticated'"
          }
        ]
      }
    },
    {
      "name": "stock_adjustments",
      "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "item_id", "type": "uuid", "nullable": false },
        { "name": "delta", "type": "integer", "nullable": false },
        { "name": "reason", "type": "text", "nullable": false },
        { "name": "created_at", "type": "timestamptz", "nullable": false, "default": "now()" },
        { "name": "created_by", "type": "uuid", "nullable": false }
      ],
      "constraints": [
        { "type": "primary-key", "columns": ["id"] },
        {
          "type": "foreign-key",
          "columns": ["item_id"],
          "referencesTable": "items",
          "referencesColumns": ["id"],
          "onDelete": "cascade"
        },
        {
          "type": "foreign-key",
          "columns": ["created_by"],
          "referencesTable": "auth.users",
          "referencesColumns": ["id"],
          "onDelete": "restrict"
        }
      ],
      "indexes": [
        { "name": "stock_adjustments_item_id_idx", "columns": ["item_id"], "unique": false }
      ],
      "rls": {
        "enabled": true,
        "policies": [
          {
            "name": "authenticated_select",
            "command": "select",
            "using": "auth.role() = 'authenticated'"
          },
          {
            "name": "authenticated_insert_own",
            "command": "insert",
            "withCheck": "auth.role() = 'authenticated' AND created_by = auth.uid()"
          }
        ]
      }
    }
  ]
}
```

Note: `stock_adjustments` deliberately has no update/delete policy — the PRD's adjustment log is append-only.

- [ ] **Step 4: Create the dashboard-heavy fixture**

Create `docs/evidence/harness-alignment/dashboard-heavy/schema-plan.json` with this exact content:

```json
{
  "schemaVersion": "1",
  "tables": [
    {
      "name": "sale_events",
      "columns": [
        { "name": "id", "type": "uuid", "nullable": false, "default": "gen_random_uuid()" },
        { "name": "event_date", "type": "date", "nullable": false },
        { "name": "category", "type": "text", "nullable": false },
        { "name": "amount", "type": "numeric", "nullable": false },
        { "name": "quantity", "type": "integer", "nullable": false },
        { "name": "created_by", "type": "uuid", "nullable": false },
        { "name": "created_at", "type": "timestamptz", "nullable": false, "default": "now()" }
      ],
      "constraints": [
        { "type": "primary-key", "columns": ["id"] },
        {
          "type": "foreign-key",
          "columns": ["created_by"],
          "referencesTable": "auth.users",
          "referencesColumns": ["id"],
          "onDelete": "restrict"
        },
        { "type": "check", "name": "sale_events_amount_positive", "expression": "amount > 0" },
        {
          "type": "check",
          "name": "sale_events_quantity_positive",
          "expression": "quantity > 0"
        }
      ],
      "indexes": [
        { "name": "sale_events_event_date_idx", "columns": ["event_date"], "unique": false },
        { "name": "sale_events_category_idx", "columns": ["category"], "unique": false }
      ],
      "rls": {
        "enabled": true,
        "policies": [
          {
            "name": "authenticated_select",
            "command": "select",
            "using": "auth.role() = 'authenticated'"
          },
          {
            "name": "authenticated_insert_own",
            "command": "insert",
            "withCheck": "auth.role() = 'authenticated' AND created_by = auth.uid()"
          }
        ]
      }
    }
  ]
}
```

- [ ] **Step 5: Create the auth-heavy fixture**

Create `docs/evidence/harness-alignment/auth-heavy/schema-plan.json` with this exact content:

```json
{
  "schemaVersion": "1",
  "tables": [
    {
      "name": "profiles",
      "columns": [
        { "name": "id", "type": "uuid", "nullable": false },
        { "name": "display_name", "type": "text", "nullable": false },
        { "name": "bio", "type": "text", "nullable": true },
        { "name": "role", "type": "text", "nullable": false, "default": "'member'" }
      ],
      "constraints": [
        { "type": "primary-key", "columns": ["id"] },
        {
          "type": "foreign-key",
          "columns": ["id"],
          "referencesTable": "auth.users",
          "referencesColumns": ["id"],
          "onDelete": "cascade"
        },
        {
          "type": "check",
          "name": "profiles_role_valid",
          "expression": "role IN ('admin', 'member')"
        }
      ],
      "indexes": [],
      "rls": {
        "enabled": true,
        "policies": [
          { "name": "member_select_own", "command": "select", "using": "id = auth.uid()" },
          {
            "name": "member_update_own",
            "command": "update",
            "using": "id = auth.uid()",
            "withCheck": "id = auth.uid()"
          },
          {
            "name": "admin_select_all",
            "command": "select",
            "using": "exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')"
          },
          {
            "name": "admin_update_all",
            "command": "update",
            "using": "exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')",
            "withCheck": "exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')"
          }
        ]
      }
    }
  ]
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/schema-plan-fixtures.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 7: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add docs/evidence/harness-alignment/crud-heavy/schema-plan.json docs/evidence/harness-alignment/dashboard-heavy/schema-plan.json docs/evidence/harness-alignment/auth-heavy/schema-plan.json packages/contracts/src/schema-plan-fixtures.test.ts
git commit -m "test(contracts): validate schema plan fixtures for the 3 HA-0.1 shapes (#480)"
```

---

### Task 3: Wire the schema-plan output contract into the workflow orchestrator

**Files:**
- Modify: `packages/contracts/src/workflow.ts:29`
- Modify: `packages/contracts/src/workflow.test.ts` (extend the `agent step outputContract` describe block, around lines 188-204)
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts` (import block ~lines 44-63, `outputSchema` selection ~lines 2778-2783, validation gate ~lines 3092-3099)
- Modify: `packages/orchestrator/src/workflow-orchestrator.test.ts` (add a new describe block after the existing `task-graph output contract (#321)` block, which ends around line 643)

**Interfaces:**
- Consumes: `SchemaPlanArtifactSchema`, `SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA` from `@agent-foundry/contracts` (Task 1, already exported from the package index).
- Produces: nothing new consumed by later tasks.

This task makes `outputContract: 'schema-plan'` on a workflow's `agent` step behave exactly like `outputContract: 'task-graph'` already does: the model is asked to conform to `SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA`, and after execution the orchestrator rejects (fails the step) any output that doesn't parse as a `SchemaPlanArtifactSchema`.

- [ ] **Step 1: Write the failing contract test**

In `packages/contracts/src/workflow.test.ts`, inside the existing `describe('agent step outputContract', ...)` block (around line 188), add a new test case right after the `'is optional and accepts task-graph'` test (after its closing `});` at line 197, before `it('rejects unknown contract names', ...)`):

```typescript
  it('accepts schema-plan', () => {
    const declared = WorkflowNodeSchema.parse({
      ...BASE_AGENT_STEP,
      outputContract: 'schema-plan',
    });
    if (declared.type !== 'agent') throw new Error('expected agent step');
    expect(declared.outputContract).toBe('schema-plan');
  });

```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/workflow.test.ts`
Expected: FAIL on the new `'accepts schema-plan'` test — `outputContract` rejects `'schema-plan'`.

- [ ] **Step 3: Widen the outputContract literal**

In `packages/contracts/src/workflow.ts`, find this line (currently line 29):

```typescript
    outputContract: z.literal('task-graph').optional(),
```

Replace it with:

```typescript
    outputContract: z.enum(['task-graph', 'schema-plan']).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/workflow.test.ts`
Expected: PASS, including the new test and the existing `'rejects unknown contract names'` test (still throws for `'browser-plan'`).

- [ ] **Step 5: Typecheck the contracts package**

Run: `npx tsc -b --pretty false`
Expected: no errors.

- [ ] **Step 6: Write the failing orchestrator test**

In `packages/orchestrator/src/workflow-orchestrator.test.ts`, add the following block immediately after the closing `});` of `describe('task-graph output contract (#321)', ...)` (which ends around line 643, right before `const SYSTEM_PROMPT_WORKFLOW`). Check the top of the file for how `WorkflowDefinitionSchema`, `WorkflowDefinition`, `makeOrchestrator`, and `seedRun` are imported/defined and reuse them exactly as the existing `TASK_GRAPH_WORKFLOW` block above does — do not reimplement or reimport them differently.

```typescript
const SCHEMA_PLAN_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'schema-plan-v1',
  name: 'Schema plan fixture',
  description: 'A single planning step constrained to emit a schema plan.',
  stack: 'node',
  nodes: [
    {
      id: 'plan-schema',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan schema',
      instructions: 'Plan the data model.',
      outputArtifact: 'schema.current',
      outputContract: 'schema-plan',
      maxAttempts: 1,
    },
  ],
});

const VALID_SCHEMA_PLAN = {
  schemaVersion: '1',
  tables: [
    {
      name: 'items',
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    },
  ],
};

describe('schema-plan output contract (#480)', () => {
  it('requests the schema-plan JSON schema and stores a conforming plan', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: SCHEMA_PLAN_WORKFLOW,
      output: () => ({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the schema.',
        data: VALID_SCHEMA_PLAN,
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      }),
    });
    await seedRun(stores, SCHEMA_PLAN_WORKFLOW.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(stores.executor.requests[0]?.outputSchema?.$id).toBe(
      SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA.$id,
    );
    const artifact = await stores.artifacts.getLatest('project-1', 'schema.current');
    expect(artifact?.content).toMatchObject({ data: { tables: [{ name: 'items' }] } });
  });

  it('fails the step instead of passing prose through as schema.current', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: SCHEMA_PLAN_WORKFLOW,
      // Default ControllableExecutor output: data is {}. Prose, not a schema plan.
    });
    await seedRun(stores, SCHEMA_PLAN_WORKFLOW.id);

    await expect(stores.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /must emit a schema plan/,
    );
    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    expect(await stores.artifacts.getLatest('project-1', 'schema.current')).toBeNull();
  });
});

```

Also add `SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA` to this test file's existing `@agent-foundry/contracts` import statement (find the import at the top of the file that already brings in `TASK_GRAPH_ARTIFACT_JSON_SCHEMA` and add `SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA` alongside it).

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts -t "schema-plan output contract"`
Expected: FAIL — `outputSchema` is `AGENT_ARTIFACT_JSON_SCHEMA` (not the schema-plan one) and prose passes through unvalidated, so the first test's `$id` assertion fails and the second test's `rejects.toThrow(/must emit a schema plan/)` doesn't throw.

- [ ] **Step 8: Add the schema-plan branch to outputSchema selection**

In `packages/orchestrator/src/workflow-orchestrator.ts`, add `SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA` and `SchemaPlanArtifactSchema` to the `@agent-foundry/contracts` import block (the one already containing `TASK_GRAPH_ARTIFACT_JSON_SCHEMA` and `GeneratedTaskGraphArtifactSchema`, around lines 44-63) — add them as two new lines in that same import statement.

Then find this exact block (around lines 2778-2783):

```typescript
    const outputSchema =
      step.outputContract === 'task-graph'
        ? TASK_GRAPH_ARTIFACT_JSON_SCHEMA
        : workflowUsesBrowserPlan(workflow, step.outputArtifact)
          ? BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA
          : AGENT_ARTIFACT_JSON_SCHEMA;
```

Replace it with:

```typescript
    const outputSchema =
      step.outputContract === 'task-graph'
        ? TASK_GRAPH_ARTIFACT_JSON_SCHEMA
        : step.outputContract === 'schema-plan'
          ? SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA
          : workflowUsesBrowserPlan(workflow, step.outputArtifact)
            ? BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA
            : AGENT_ARTIFACT_JSON_SCHEMA;
```

- [ ] **Step 9: Add the schema-plan validation gate**

Find this exact block (around lines 3092-3099):

```typescript
      if (step.outputContract === 'task-graph') {
        const graph = GeneratedTaskGraphArtifactSchema.safeParse(result.output);
        if (!graph.success) {
          throw new Error(
            `Step ${step.id} must emit a task graph in data; output failed validation: ${formatZodIssues(graph.error, 'plan')}`,
          );
        }
      }
```

Replace it with:

```typescript
      if (step.outputContract === 'task-graph') {
        const graph = GeneratedTaskGraphArtifactSchema.safeParse(result.output);
        if (!graph.success) {
          throw new Error(
            `Step ${step.id} must emit a task graph in data; output failed validation: ${formatZodIssues(graph.error, 'plan')}`,
          );
        }
      } else if (step.outputContract === 'schema-plan') {
        const schemaPlan = SchemaPlanArtifactSchema.safeParse(result.output);
        if (!schemaPlan.success) {
          throw new Error(
            `Step ${step.id} must emit a schema plan in data; output failed validation: ${formatZodIssues(schemaPlan.error, 'plan')}`,
          );
        }
      }
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts -t "schema-plan output contract"`
Expected: PASS, both tests green.

Then run the full orchestrator test file to make sure nothing else broke:

Run: `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts`
Expected: PASS, all tests green (including the pre-existing `task-graph output contract (#321)` tests).

- [ ] **Step 11: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/contracts/src/workflow.ts packages/contracts/src/workflow.test.ts packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/workflow-orchestrator.test.ts
git commit -m "feat(orchestrator): validate schema-plan step output like task-graph (#480)"
```

---

### Task 4: Review surface — render the schema plan in the artifact viewer dialog

**Files:**
- Modify: `apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.tsx`
- Modify: `apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.test.tsx`

**Interfaces:**
- Consumes: `SchemaPlanArtifactSchema`, `type SchemaPlan` from `@agent-foundry/contracts` (Task 1).
- Produces: nothing new consumed by later tasks.

This task adds a `SchemaPlanView` render branch to the existing artifact viewer dialog, following the exact same pattern as the existing `TaskGraphView`/`parseTaskGraph` branch in the same file — the operator opens an artifact of unknown shape, and the dialog tries each known Zod-validated contract before falling back to raw JSON.

- [ ] **Step 1: Write the failing component test**

In `apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.test.tsx`, add this new `describe` block at the end of the file (after the closing `});` of `describe('ArtifactViewerDialog task graph rendering', ...)`):

```typescript

describe('ArtifactViewerDialog schema plan rendering', () => {
  it('renders a conforming schema plan as a readable table list', () => {
    const markup = render({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned the schema.',
      data: {
        schemaVersion: '1',
        tables: [
          {
            name: 'items',
            columns: [
              { name: 'id', type: 'uuid', nullable: false },
              { name: 'name', type: 'text', nullable: false },
            ],
            constraints: [{ type: 'primary-key', columns: ['id'] }],
            indexes: [],
            rls: {
              enabled: true,
              policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
            },
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });

    expect(markup).toContain('data-testid="schema-plan-view"');
    expect(markup).toContain('items');
    expect(markup).toContain('id (uuid)');
    expect(markup).toContain('all · authenticated_all');
  });

  it('falls back to raw JSON for a schema plan that fails validation instead of crashing', () => {
    const markup = render({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned the schema.',
      data: {
        schemaVersion: '1',
        tables: [
          {
            name: 'items',
            columns: [{ name: 'id', type: 'uuid', nullable: false }],
            constraints: [],
            indexes: [],
            // No RLS declared — invalid.
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });

    expect(markup).not.toContain('data-testid="schema-plan-view"');
    expect(markup).toContain('items');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.test.tsx`
Expected: FAIL — the new tests don't find `data-testid="schema-plan-view"` in the markup because the fallback `<pre>` render doesn't contain that testid at all (assertion mismatch), and neither test's positive assertions are met yet.

- [ ] **Step 3: Add the SchemaPlanView branch**

In `apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.tsx`, update the import block at the top of the file. Find:

```typescript
import {
  TaskGraphArtifactSchema,
  VerificationReportSchema,
  type StoredArtifact,
  type TaskGraph,
  type VerificationReport,
} from '@agent-foundry/contracts';
```

Replace it with:

```typescript
import {
  SchemaPlanArtifactSchema,
  TaskGraphArtifactSchema,
  VerificationReportSchema,
  type SchemaPlan,
  type StoredArtifact,
  type TaskGraph,
  type VerificationReport,
} from '@agent-foundry/contracts';
```

Then find:

```typescript
function parseTaskGraph(content: unknown): TaskGraph | null {
  const parsed = TaskGraphArtifactSchema.safeParse(content);
  return parsed.success ? parsed.data.data : null;
}
```

Add this new function right after it:

```typescript

function parseSchemaPlan(content: unknown): SchemaPlan | null {
  const parsed = SchemaPlanArtifactSchema.safeParse(content);
  return parsed.success ? parsed.data.data : null;
}
```

Then find the `TaskGraphView` function (starts `function TaskGraphView({ graph }: { graph: TaskGraph }) {` and ends with its closing `}` right before `function BlobArtifactPreview`). Add this new function right after `TaskGraphView`'s closing brace, before `function BlobArtifactPreview`:

```typescript

function SchemaPlanView({ plan }: { plan: SchemaPlan }) {
  return (
    <div className="flex flex-col gap-2" data-testid="schema-plan-view">
      {plan.tables.map((table) => (
        <div key={table.name} className="border-hairline rounded-card border px-3 py-2 text-[13px]">
          <p className="text-ink font-medium">{table.name}</p>
          <p className={HINT}>
            Colunas: {table.columns.map((column) => `${column.name} (${column.type})`).join(', ')}
          </p>
          <p className={HINT}>
            RLS: {table.rls.policies.map((policy) => `${policy.command} · ${policy.name}`).join(', ')}
          </p>
        </div>
      ))}
    </div>
  );
}
```

Then, inside the `ArtifactViewerDialog` component body, find:

```typescript
  if (!selected) return null;
  const taskGraph = parseTaskGraph(selected.content);
```

Replace it with:

```typescript
  if (!selected) return null;
  const taskGraph = parseTaskGraph(selected.content);
  const schemaPlan = parseSchemaPlan(selected.content);
```

Finally, find the render dispatch chain:

```typescript
        ) : taskGraph ? (
          <TaskGraphView graph={taskGraph} />
        ) : isVerificationReport(selected.content) ? (
```

Replace it with:

```typescript
        ) : taskGraph ? (
          <TaskGraphView graph={taskGraph} />
        ) : schemaPlan ? (
          <SchemaPlanView plan={schemaPlan} />
        ) : isVerificationReport(selected.content) ? (
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.test.tsx`
Expected: PASS, all tests green (existing task-graph tests plus the two new schema-plan tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/project/\[id\]/dialogs/artifact-viewer-dialog.tsx apps/web/app/project/\[id\]/dialogs/artifact-viewer-dialog.test.tsx
git commit -m "feat(web): render schema plan artifacts in the artifact viewer dialog (#480)"
```

---

### Task 5: Docs — ADR status and domain glossary

**Files:**
- Modify: `docs/adr/0060-schema-first-plan-artifact.md:3`
- Modify: `CONTEXT.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks. Docs-only, no tests (no logic to cover).

- [ ] **Step 1: Flip the ADR status**

In `docs/adr/0060-schema-first-plan-artifact.md`, find line 3:

```markdown
- Status: Proposed
```

Replace it with:

```markdown
- Status: Accepted
```

- [ ] **Step 2: Add the Schema Plan term to the domain glossary**

In `CONTEXT.md`, find the end of the file (the `Task Graph Execution` entry, currently the last lines):

```markdown
**Task Graph Execution**:
The dependency-ordered progression of a Task Graph. A task completes only after its implementation and declared acceptance channel succeed; failure stops dependent tasks while preserving tasks already completed.
_Avoid_: Task loop, batch execution
```

Add this new entry right after it (keep exactly one blank line between entries, matching the existing spacing):

```markdown

**Schema Plan**:
A validated, operator-reviewable data-model artifact — tables, columns, constraints, indexes, and per-table RLS policies — that implementation tasks receive as input instead of inventing tables ad hoc. Reviewed and approved before implementation tasks execute.
_Avoid_: Data model doc, migration plan
```

- [ ] **Step 3: Verify the docs changes render sensibly**

Run: `git diff docs/adr/0060-schema-first-plan-artifact.md CONTEXT.md`
Expected: a clean two-file diff — one status line flip, one new glossary entry appended.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0060-schema-first-plan-artifact.md CONTEXT.md
git commit -m "docs: accept ADR 0060 and add Schema Plan to the domain glossary (#480)"
```

---

## Final Verification (after all tasks, before requesting final review)

- [ ] Run `npx tsc -b --pretty false` from the repo root — no errors.
- [ ] Run `npm run test:unit:fast` — all green.
- [ ] Run `npx vitest run packages/contracts/src/schema-plan.test.ts packages/contracts/src/schema-plan-fixtures.test.ts packages/contracts/src/workflow.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts "apps/web/app/project/[id]/dialogs/artifact-viewer-dialog.test.tsx"` — all green.
- [ ] Confirm `packages/platform/src/supabase-runtime.ts` (destructive-migration approval gate) has zero diff: `git diff main -- packages/platform/src/supabase-runtime.ts` is empty.
