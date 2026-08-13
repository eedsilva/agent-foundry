import type {
  RlsPolicy,
  SchemaColumn,
  SchemaConstraint,
  SchemaIndex,
  SchemaPlan,
  SchemaTable,
} from './schema-plan.js';

const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(name: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : `"${name}"`;
}

function qualifyTableRef(name: string): string {
  return name.includes('.') ? name : `public.${quoteIdentifier(name)}`;
}

function columnList(columns: readonly string[]): string {
  return columns.map(quoteIdentifier).join(', ');
}

function columnDefinition(column: SchemaColumn): string {
  const parts = [quoteIdentifier(column.name), column.type];
  if (column.nullable === false) parts.push('not null');
  if (column.default !== undefined) parts.push(`default ${column.default}`);
  return parts.join(' ');
}

function constraintDefinition(constraint: SchemaConstraint): string {
  switch (constraint.type) {
    case 'primary-key':
      return `primary key (${columnList(constraint.columns)})`;
    case 'unique':
      return `unique (${columnList(constraint.columns)})`;
    case 'foreign-key':
      return (
        `foreign key (${columnList(constraint.columns)}) ` +
        `references ${qualifyTableRef(constraint.referencesTable)} (${columnList(constraint.referencesColumns)}) ` +
        `on delete ${constraint.onDelete === 'set-null' ? 'set null' : constraint.onDelete}`
      );
    case 'check':
      return `constraint ${quoteIdentifier(constraint.name)} check (${constraint.expression})`;
  }
}

function createTableStatement(table: SchemaTable): string {
  const items = [
    ...table.columns.map(columnDefinition),
    ...table.constraints.map(constraintDefinition),
  ];
  return `create table if not exists ${qualifyTableRef(table.name)} ( ${items.join(', ')} );`;
}

function createIndexStatement(table: SchemaTable, index: SchemaIndex): string {
  const kind = index.unique ? 'create unique index if not exists' : 'create index if not exists';
  return `${kind} ${quoteIdentifier(index.name)} on ${qualifyTableRef(table.name)} (${columnList(index.columns)});`;
}

function policyStatements(table: SchemaTable, policy: RlsPolicy): string[] {
  const clauses = [`for ${policy.command}`];
  if (policy.using !== undefined) clauses.push(`using (${policy.using})`);
  if (policy.withCheck !== undefined) clauses.push(`with check (${policy.withCheck})`);
  return [
    `drop policy if exists ${quoteIdentifier(policy.name)} on ${qualifyTableRef(table.name)};`,
    `create policy ${quoteIdentifier(policy.name)} on ${qualifyTableRef(table.name)} ${clauses.join(' ')};`,
  ];
}

function tableStatements(table: SchemaTable): string[] {
  return [
    createTableStatement(table),
    ...table.indexes.map((index) => createIndexStatement(table, index)),
    `alter table ${qualifyTableRef(table.name)} enable row level security;`,
    ...table.rls.policies.flatMap((policy) => policyStatements(table, policy)),
  ];
}

export function generateSchemaPlanSql(plan: SchemaPlan): string {
  const header = `-- Generated from the approved schema plan artifact (schemaVersion ${plan.schemaVersion}). Forward-only; do not edit by hand.`;
  const statements = plan.tables.flatMap(tableStatements);
  return [header, ...statements].join('\n');
}
