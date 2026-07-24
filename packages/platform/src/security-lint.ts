import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SecurityReportSchema,
  type SecurityFinding,
  type SecurityReport,
  type SecuritySeverity,
} from '@agent-foundry/contracts';
import { destructiveStatements, isNotFound, sqlStatements } from './supabase-runtime.js';

const WRITE_OPS = new Set(['insert', 'update', 'delete']);

interface PolicyRecord {
  file: string;
  statement: string;
  table: string;
  op: string;
  roles: string[];
}

interface TableRecord {
  name: string;
  file: string;
  statement: string;
  sensitive: boolean;
  rlsEnabled: boolean;
  policies: PolicyRecord[];
}

// ponytail: regex-on-statement-text, same precedent as destructiveStatements() —
// not a real SQL parser. Upgrade to a proper parser if statement shapes diverge.
const CREATE_TABLE_RE =
  /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/i;
const ENABLE_RLS_RE =
  /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i;
const POLICY_RE =
  /^CREATE\s+POLICY\s+.+?\s+ON\s+((?:"?[\w]+"?\.)?"?[\w]+"?)\s+(?:AS\s+(?:PERMISSIVE|RESTRICTIVE)\s+)?FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+([^\n]+?)(?=\s+USING\s*\(|\s+WITH\s+CHECK\s*\(|$)/is;
const USING_TRUE_RE = /\bUSING\s*\(\s*true\s*\)/i;
const CHECK_TRUE_RE = /\bWITH\s+CHECK\s*\(\s*true\s*\)/i;
const GRANT_TABLE_RE =
  /^GRANT\s+([\w\s,]+?)\s+ON\s+TABLE\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+TO\s+([^\n;]+)/i;
const REVOKE_TABLE_RE =
  /^REVOKE\s+([\w\s,]+?)\s+ON\s+TABLE\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+FROM\s+([^\n;]+)/i;
const SENSITIVE_RE = /\b(?:user_id|owner_id)\b|\breferences\s+(?:public\.)?auth\.users\b/i;

export function lintMigrationsSql(sqlByFile: { file: string; sql: string }[]): SecurityReport {
  const tables = new Map<string, TableRecord>();
  const anonWriteGrants = new Map<string, Set<string>>(); // table -> write ops currently granted to anon
  const findings: SecurityFinding[] = [];

  let findingCounter = 0;
  function makeFinding(input: {
    rule: SecurityFinding['rule'];
    severity: SecuritySeverity;
    table: string | null;
    location: string;
    evidence: string;
    remediation: string;
  }): SecurityFinding {
    findingCounter += 1;
    return {
      id: `${input.rule}-${findingCounter}`,
      rule: input.rule,
      severity: input.severity,
      table: input.table,
      location: input.location,
      evidence: input.evidence.trim().slice(0, 2_000),
      remediation: input.remediation,
    };
  }

  for (const { file, sql } of sqlByFile) {
    for (const statement of sqlStatements(sql)) {
      const createTable = CREATE_TABLE_RE.exec(statement);
      if (createTable) {
        const name = createTable[1]!;
        tables.set(name, {
          name,
          file,
          statement,
          sensitive: SENSITIVE_RE.test(statement),
          rlsEnabled: false,
          policies: [],
        });
        continue;
      }

      const enableRls = ENABLE_RLS_RE.exec(statement);
      if (enableRls) {
        const table = tables.get(enableRls[1]!);
        if (table) table.rlsEnabled = true;
        continue;
      }

      const policy = POLICY_RE.exec(statement);
      if (policy) {
        const tableName = stripPublicSchema(policy[1]!);
        const op = policy[2]!.toLowerCase();
        const roles = policy[3]!
          .split(',')
          .map((role) => role.trim().toLowerCase())
          .filter(Boolean);
        const table = tables.get(tableName);
        if (table) table.policies.push({ file, statement, table: tableName, op, roles });

        const isWrite = op === 'all' || WRITE_OPS.has(op);
        if (
          isWrite &&
          (roles.includes('anon') || USING_TRUE_RE.test(statement) || CHECK_TRUE_RE.test(statement))
        ) {
          findings.push(
            makeFinding({
              rule: 'anon-write-policy',
              severity: 'critical',
              table: table ? tableName : null,
              location: file,
              evidence: statement,
              remediation:
                'Scope the policy to authenticated, owner-checked rows instead of anon or an unconditional (true) clause.',
            }),
          );
        }
        continue;
      }

      const grant = GRANT_TABLE_RE.exec(statement);
      if (grant) {
        const ops = parseOps(grant[1]!);
        const table = grant[2]!;
        const roles = parseRoles(grant[3]!);
        // PUBLIC is a pseudo-role that includes anon (and every other role) in
        // Postgres, so a grant to public is equivalent to a grant to anon here.
        if (roles.includes('anon') || roles.includes('public')) {
          const writeOps = writeOpsIn(ops);
          if (writeOps.length) {
            const current = anonWriteGrants.get(table) ?? new Set<string>();
            for (const op of writeOps) current.add(op);
            anonWriteGrants.set(table, current);
          }
        }
        continue;
      }

      const revoke = REVOKE_TABLE_RE.exec(statement);
      if (revoke) {
        const ops = parseOps(revoke[1]!);
        const table = revoke[2]!;
        const roles = parseRoles(revoke[3]!);
        if (roles.includes('anon')) {
          const current = anonWriteGrants.get(table);
          if (current) for (const op of writeOpsIn(ops)) current.delete(op);
        }
        continue;
      }
    }

    for (const statement of destructiveStatements(sql)) {
      findings.push(
        makeFinding({
          rule: 'destructive-migration',
          severity: 'high',
          table: null,
          location: file,
          evidence: statement,
          remediation:
            'Verify a recent backup and explicit release approval before shipping this destructive statement.',
        }),
      );
    }
  }

  for (const table of tables.values()) {
    if (!table.rlsEnabled) {
      findings.push(
        makeFinding({
          rule: 'missing-rls',
          severity: 'high',
          table: table.name,
          location: table.file,
          evidence: `CREATE TABLE public.${table.name} has no matching ENABLE ROW LEVEL SECURITY statement.`,
          remediation: `Run "ALTER TABLE public.${table.name} ENABLE ROW LEVEL SECURITY;" and add owner-scoped policies.`,
        }),
      );
    } else if (table.sensitive && table.policies.length === 0) {
      findings.push(
        makeFinding({
          rule: 'sensitive-table-no-policy',
          severity: 'critical',
          table: table.name,
          location: table.file,
          evidence: `Table public.${table.name} is sensitive (owner-scoped) and has RLS enabled but no CREATE POLICY statements reference it.`,
          remediation: `Add owner-scoped CREATE POLICY statements for public.${table.name} (e.g. using (user_id = (select auth.uid()))).`,
        }),
      );
    }
  }

  for (const [table, ops] of anonWriteGrants) {
    if (ops.size === 0) continue;
    const record = tables.get(table);
    if (!record?.sensitive) continue;
    const opsList = [...ops].sort().join(', ').toUpperCase();
    findings.push(
      makeFinding({
        rule: 'anon-grant',
        severity: 'high',
        table,
        location: record.file,
        evidence: `GRANT ${opsList} ON TABLE public.${table} TO anon is still in effect (not subsequently revoked).`,
        remediation: `Revoke ${[...ops].join(', ')} on public.${table} from anon and grant only to authenticated with an owner-scoped policy.`,
      }),
    );
  }

  const report = SecurityReportSchema.parse({
    schemaVersion: '1',
    findings,
    blocked: false,
    generatedAt: new Date().toISOString(),
  });
  report.blocked = blocksRelease(report);
  return report;
}

export async function lintMigrationsDir(dir: string): Promise<SecurityReport> {
  const migrationsDir = join(dir, 'supabase', 'migrations');
  let entries;
  try {
    entries = await readdir(migrationsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return lintMigrationsSql([]);
    throw error;
  }
  const files = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const sqlByFile = await Promise.all(
    files.map(async (file) => ({
      file,
      sql: await readFile(join(migrationsDir, file), 'utf8'),
    })),
  );
  return lintMigrationsSql(sqlByFile);
}

export function blocksRelease(report: SecurityReport): boolean {
  return report.findings.some(
    (finding) => finding.severity === 'high' || finding.severity === 'critical',
  );
}

function stripPublicSchema(name: string): string {
  const unquoted = name.replace(/"/g, '');
  return unquoted.replace(/^public\./i, '');
}

// Mirrors the CREATE POLICY branch's `op === 'all' || WRITE_OPS.has(op)` handling:
// GRANT/REVOKE ALL is the broadest form of write access and must count as covering
// insert/update/delete, not fall through because WRITE_OPS.has('all') is false.
function writeOpsIn(ops: string[]): string[] {
  return ops.includes('all') ? [...WRITE_OPS] : ops.filter((op) => WRITE_OPS.has(op));
}

function parseOps(raw: string): string[] {
  return raw
    .split(',')
    .map((op) => op.trim().toLowerCase())
    .filter(Boolean);
}

function parseRoles(raw: string): string[] {
  return raw
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
}
