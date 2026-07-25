## Graphify task startup

Every primary agent and subagent must do this before reading source or starting a task:

1. Activate Caveman ultra mode (`/caveman ultra`).
2. Run `npm run graphify:refresh` from the repository root. It incrementally rebuilds the local AST graph, refreshes every community label from the current code paths, and regenerates `graphify-out/GRAPH_REPORT.md` without API cost.
3. Read `graphify-out/GRAPH_REPORT.md`; use `graphify query`, `graphify path`, or `graphify explain` before broad raw-file searches.

After changing code, run `npm run graphify:refresh` again. For docs, images, or other semantic inputs, run `/graphify . --update` instead. If Graphify is missing, install the official CLI once with `uv tool install graphifyy` — the PyPI package name is `graphifyy` (double-y; `graphify` was unaffiliated/unavailable), but it installs a CLI command named `graphify`, matching the `graphify:refresh` script above. See https://github.com/Graphify-Labs/graphify. `graphify-out/` is local generated state and is intentionally not committed.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `eedsilva/agent-foundry`, organised into roadmap milestones, with native sub-issues and issue dependencies for parent/blocking edges. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), applied alongside the repo's existing `kind:` / `area:` / `priority:` / `track:` / `target:` / `commitment:` taxonomy. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`, shared across all packages. See `docs/agents/domain.md`.

## Checks: what to run when

Full rules live in `AGENTS.md` ("Checks: what to run when") — read that section before running or editing any test/lint/build command. Summary:

- Inner loop: `npm run test:unit:fast` (~30s) + `npx vitest run <slow files you touched>`.
- Pre-PR: `npm run check`. E2E and regression gate are CI-only.
- Slow bucket stays `--maxWorkers=1`; fast/slow lists in `package.json` must stay an exact partition (`npx vitest list --filesOnly` to verify).
- Never remove: `.claude/` ignore entries (prettier/eslint/gitignore), `--cache` flags, `--force` on typecheck or the `dist-types/` + `emitDeclarationOnly` setup in package tsconfigs (it's what keeps incremental `tsc -b` correct next to tsup `--clean`).
