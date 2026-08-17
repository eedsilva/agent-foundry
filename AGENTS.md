## Graphify task startup

Every primary agent and subagent must do this before reading source or starting a task:

1. Activate Caveman ultra mode (`/caveman ultra`).
2. Run `npm run graphify:refresh` from the repository root. It incrementally rebuilds the local AST graph, refreshes every community label from the current code paths, and regenerates `graphify-out/GRAPH_REPORT.md` without API cost.
3. Read `graphify-out/GRAPH_REPORT.md`; use `graphify query`, `graphify path`, or `graphify explain` before broad raw-file searches.

After changing code, run `npm run graphify:refresh` again. For docs, images, or other semantic inputs, run `/graphify . --update` instead. If Graphify is missing, install the official CLI once with `uv tool install graphifyy` — the PyPI package name is `graphifyy` (double-y; `graphify` was unaffiliated/unavailable), but it installs a CLI command named `graphify`, matching the `graphify:refresh` script above. See https://github.com/Graphify-Labs/graphify. `graphify-out/` is local generated state and is intentionally not committed.

## Checks: what to run when

- **While editing (inner loop):** `npm run test:unit:fast` (~30s, 135 pure-unit files in parallel) plus the specific slow-bucket files you touched via `npx vitest run <path>`.
- **Before opening/updating a PR:** `npm run check` — runs `check:static` (format/lint/architecture/roadmap/typecheck in parallel, ~2.5min), then `npm test`, `build`, `secrets:check`. E2E specs (Playwright, Supabase) and the regression gate run in CI only; don't run them locally unless debugging one.
- **Static gates only:** `npm run check:static`. Prettier and ESLint are `--cache`d — warm reruns take ~4s each.
- **Reading the verdict:** the chain short-circuits. `scripts/lib/check-scripts.test.mjs` walks it from `check` and pins that no bucket swallows a failure with `||` or `;`, and that `test:scripts` really exits non-zero on a red script test. Two runner quirks can still hide a whole bucket, so don't reintroduce them: `node --test` handed a glob that matches nothing exits 0 (hence the `ls` guard in front of `test:scripts`), and it sets `NODE_TEST_CONTEXT` in every test child, so a nested runner reports to its parent instead of owning its exit code. Given that, the exit code is the verdict — "exited 0 with failures in the output" means it was measured wrong, usually by piping (`npm run check | tail` reports `tail`'s status). Redirect to a file and `echo $?`.

Test-suite rules:

- `test:unit` = `test:unit:fast` (parallel) then `test:unit:slow` (`--maxWorkers=1`). The slow bucket holds Docker-sandbox, Postgres-testcontainers, port-binding API, process-spawning, and wall-clock-assertion tests. **Never parallelize the slow bucket** — those tests flake under CPU contention, and parallelizing gains almost nothing (measured 2026-07).
- The two buckets are an exact partition of the suite. If you add or move a test file, keep it that way: update the `--exclude` globs (fast) and positional paths (slow) together in `package.json`, and verify with `npx vitest list --filesOnly` that fast + slow counts equal the total.
- New test that binds ports, spawns processes, uses containers, or asserts on elapsed time → slow bucket.
- If a fast-bucket test flakes only under parallelism, move it to the slow bucket rather than retrying.

Perf guardrails (do not undo):

- Keep `.claude/` in `.prettierignore`, `.gitignore`, and the `ignores` list in `eslint.config.mjs`. `.claude/worktrees/` holds many GB of stale worktrees ignored only via `.git/info/exclude`, which prettier/eslint do not read — without these entries the lint gates take 5+ minutes instead of seconds. Any new lint-like tool must get the same ignore entry.
- Keep `--cache` on the prettier and eslint scripts.
- Composite tsconfigs emit declarations to `dist-types/` (`emitDeclarationOnly`), NEVER to `dist/` — tsup `--clean` owns `dist/`; `clean` preserves tsc's declarations while deleting `tsconfig.tsbuildinfo`, so incremental `tsc -b` can rebuild from a consistent state. Incremental `tsc -b` stays fast: ~13s cold, ~2s warm. If typecheck state ever looks wrong, `npm run clean` and re-run.
- Postgres test suites share one testcontainer via `SHARED_PG=1` (set by `test:unit:slow`; globalSetup at `packages/persistence/src/postgres/global-setup.ts`). New Postgres suites must use `describePostgres` from `testing.ts` and rely on its truncate-based cleanup; without the env flag each suite boots its own container.
- `typecheck` stays incremental without `--force`; `clean` must preserve `dist-types/` while deleting `*.tsbuildinfo`.
