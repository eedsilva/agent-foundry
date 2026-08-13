// One-off capture tool that produced run2-transcript.txt for #529. It is not
// part of the build or the test suite; it needs a live Supabase stack for the
// named project, so re-running it means reproducing a run first.
//
// Invoked, from the worktree root, as:
//   npx tsx docs/evidence/harness-alignment/schema-first/run2-transcript-script.ts \
//     <DATA_DIR> 01KZWVNGD4RM32PXWKEJXS69N6
//
// Proves, via the exact production entry point workflow-orchestrator.ts's
// syncGeneratedDatabase calls (SupabaseGeneratedProjectRuntime.
// applyWorkspaceMigrations, no approval argument):
//   1. the batch is refused because of the agent-authored `drop table` file,
//      not the generated schema-plan migration;
//   2. once that file is set aside, the schema-plan migration applies for
//      real, against the live DB;
//   3. the live DB matches the approved schema.current artifact, verified
//      both via the production verifySchema() and via independent raw SQL;
//   4. restoring the offending file makes the gate fire again, identically.
import { readdir, readFile, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { SupabaseGeneratedProjectRuntime, destructiveStatements } from '@agent-foundry/platform';
import { ValidationError } from '@agent-foundry/domain';
import { SchemaPlanArtifactSchema } from '@agent-foundry/contracts';
import { FileArtifactStore, FsBlobStore } from '@agent-foundry/persistence';

const execFileAsync = promisify(execFile);
const EXEC_OPTS = { maxBuffer: 10 * 1024 * 1024 };
const EXPECTED_MESSAGE = 'Destructive migration requires approval and verified backup.';

async function main(): Promise<void> {
  const [dataDir, projectId] = process.argv.slice(2);
  if (!dataDir || !projectId) {
    throw new Error('Usage: tsx 529-destructive-gate-demo.ts <dataDir> <projectId>');
  }

  const runtime = new SupabaseGeneratedProjectRuntime({ dataDir });
  const workspaceMigrationsDir = join(dataDir, 'projects', projectId, 'workspace', 'supabase', 'migrations');
  const environmentWorkdir = join(dataDir, 'projects', projectId, 'environment');
  const targetMigrationsDir = join(environmentWorkdir, 'supabase', 'migrations');
  const apply = () => runtime.applyWorkspaceMigrations({ projectId, workspaceMigrationsDir });

  async function getDbUrl(): Promise<string> {
    const { stdout } = await execFileAsync(
      'supabase',
      ['status', '--workdir', environmentWorkdir, '--output', 'json'],
      EXEC_OPTS,
    );
    const dbUrl = (JSON.parse(stdout) as Record<string, unknown>).DB_URL;
    if (typeof dbUrl !== 'string' || !URL.canParse(dbUrl)) {
      throw new Error(`supabase status returned no usable DB_URL. stdout: ${stdout}`);
    }
    const protocol = new URL(dbUrl).protocol;
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      throw new Error(`DB_URL has unexpected protocol ${protocol}`);
    }
    return dbUrl;
  }

  async function psqlPretty(dbUrl: string, query: string): Promise<void> {
    const { stdout } = await execFileAsync('psql', [dbUrl, '-c', query], EXEC_OPTS);
    console.log(stdout.trimEnd());
  }

  async function psqlRaw(dbUrl: string, query: string): Promise<string> {
    const { stdout } = await execFileAsync('psql', [dbUrl, '-tAc', query], EXEC_OPTS);
    return stdout.trim();
  }

  async function appliedVersions(dbUrl: string): Promise<Set<string>> {
    const raw = await psqlRaw(dbUrl, 'select version from supabase_migrations.schema_migrations order by version;');
    return new Set(raw.split('\n').map((line) => line.trim()).filter(Boolean));
  }

  // The crashed run's copy loop already staged every workspace *.sql file
  // into the environment's migrations dir before `migrate up` ever threw
  // (applyWorkspaceMigrations copies all "fresh" files up front, then calls
  // migrate() once). On a plain retry, applyWorkspaceMigrations only compares
  // filenames present in that target dir, sees nothing new, and silently
  // no-ops -- it never re-runs the destructive check or the CLI apply. Before
  // every apply() call below we delete environment-side copies whose version
  // isn't actually recorded in supabase_migrations.schema_migrations yet, so
  // applyWorkspaceMigrations re-evaluates the real pending batch instead of
  // short-circuiting on stale bookkeeping from the crash.
  async function pruneStaleTargetCopies(dbUrl: string): Promise<void> {
    const applied = await appliedVersions(dbUrl);
    const files = await readdir(targetMigrationsDir).catch(() => [] as string[]);
    for (const file of files) {
      const version = file.split('_')[0];
      if (version && !applied.has(version)) {
        await unlink(join(targetMigrationsDir, file));
        console.log(`  pruned stale unapplied environment copy: ${file}`);
      }
    }
  }

  async function attemptApplyAndReport(): Promise<void> {
    try {
      const result = await apply();
      console.log('applyWorkspaceMigrations did NOT throw. Result:', result);
      console.log('GATE DID NOT FIRE: expected a ValidationError, got none.');
    } catch (error) {
      const err = error as Error;
      console.log('error constructor:', err.constructor.name);
      console.log('error message:', err.message);
      if (!(error instanceof ValidationError) || err.message !== EXPECTED_MESSAGE) {
        console.log('GATE DID NOT FIRE AS EXPECTED: wrong error type or message.');
      }
    }
  }

  const dbUrl = await getDbUrl();

  console.log('## 0. STATE BEFORE');
  await psqlPretty(
    dbUrl,
    "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' order by relname;",
  );
  await psqlPretty(
    dbUrl,
    "select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public' order by tablename, policyname;",
  );
  await psqlPretty(dbUrl, 'select version from supabase_migrations.schema_migrations order by version;');

  let quarantinedPath: string | undefined;
  let originalPath: string | undefined;
  try {
    console.log('\n## 1. GATE — batch refused as the run left it');
    const workspaceFiles = (await readdir(workspaceMigrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const offending: string[] = [];
    for (const file of workspaceFiles) {
      const sql = await readFile(join(workspaceMigrationsDir, file), 'utf8');
      const statements = destructiveStatements(sql);
      console.log(`  ${file}: ${statements.length ? statements.join(' | ') : '(none)'}`);
      if (statements.length) offending.push(file);
    }
    if (offending.length !== 1) {
      console.log(
        `GATE DID NOT FIRE AS EXPECTED: expected exactly one destructive migration file, found ${offending.length}: ${offending.join(', ')}`,
      );
    }
    await pruneStaleTargetCopies(dbUrl);
    await attemptApplyAndReport();

    console.log('\n## 2. APPLY — the artifact-derived migration alone');
    const destructiveFile = offending[0] ?? '20260813062500_counter.sql';
    originalPath = join(workspaceMigrationsDir, destructiveFile);
    quarantinedPath = join(dirname(workspaceMigrationsDir), `_quarantine_${destructiveFile}`);
    await rename(originalPath, quarantinedPath);
    console.log(`moved ${originalPath} -> ${quarantinedPath}`);
    await pruneStaleTargetCopies(dbUrl);
    const applyResult = await apply();
    console.log('applyWorkspaceMigrations result:', applyResult);
    if (applyResult === null) {
      console.log('GATE DID NOT FIRE AS EXPECTED: expected a real apply, got a no-op.');
    }
    await psqlPretty(dbUrl, 'select version from supabase_migrations.schema_migrations order by version;');

    console.log('\n## 3. VERIFY — verifySchema green + RLS by query');
    const blobStore = new FsBlobStore(dataDir, {
      signingSecret: 'evidence-script-unused-signing-secret',
      publicBaseUrl: 'http://127.0.0.1',
    });
    const artifacts = new FileArtifactStore(dataDir, blobStore);
    const schemaArtifact = await artifacts.getLatest(projectId, 'schema.current');
    if (!schemaArtifact) {
      console.log('GATE DID NOT FIRE AS EXPECTED: no schema.current artifact found — cannot verify.');
    } else {
      const parsed = SchemaPlanArtifactSchema.safeParse(schemaArtifact.content);
      if (!parsed.success) {
        console.log('GATE DID NOT FIRE AS EXPECTED: schema.current artifact failed to parse:', parsed.error.message);
      } else {
        console.log(
          `loaded schema.current revision ${schemaArtifact.metadata.revision}, tables: ${parsed.data.data.tables.map((t) => t.name).join(', ')}`,
        );
        const verification = await runtime.verifySchema({ projectId, tables: parsed.data.data.tables });
        console.log('verifySchema result:', JSON.stringify(verification, null, 2));
        const hasProblems = Object.values(verification).some((list) => list.length > 0);
        if (hasProblems) console.log('GATE DID NOT FIRE AS EXPECTED: verifySchema reported problems (see above).');
      }
    }
    console.log('-- independent raw SQL, not via verifySchema --');
    await psqlPretty(
      dbUrl,
      "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' order by relname;",
    );
    await psqlPretty(
      dbUrl,
      "select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public' order by tablename, policyname;",
    );
    await psqlPretty(
      dbUrl,
      "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position;",
    );
  } finally {
    console.log('\n## 4. RESTORE + GATE AGAIN');
    if (quarantinedPath && originalPath) {
      await rename(quarantinedPath, originalPath);
      console.log(`restored ${quarantinedPath} -> ${originalPath}`);
      await pruneStaleTargetCopies(dbUrl);
      await attemptApplyAndReport();
    } else {
      console.log('no file was quarantined; nothing to restore');
    }
    const remaining = (await readdir(workspaceMigrationsDir)).sort();
    console.log('workspace migrations dir now contains:', remaining.join(', '));
  }
}

main().catch((error: unknown) => {
  console.error('FATAL:', error);
  process.exitCode = 1;
});
