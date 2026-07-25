# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `CONTEXT.md` at the root and one `docs/adr/` directory, shared across every package. The `apps/*` + `packages/*` workspace layout is a build-time split, not a domain split — `run`, `artifact`, `workflow`, `step`, `executor`, and `task` cross every package boundary and must mean the same thing everywhere.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

Also worth reading before touching the orchestration core, because they carry decisions the code assumes:

- `docs/ARCHITECTURE.md`
- `docs/PRODUCT_CONTRACT.md`
- `docs/MODEL_ROUTING.md`
- `docs/DEFINITION_OF_READY.md` / `docs/DEFINITION_OF_DONE.md`

## File structure

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   ├── 0001-cli-first-execution.md
│   │   ├── 0007-local-supabase-per-project.md
│   │   └── …
│   └── evidence/          ← investigation notes, one per issue or topic
├── apps/                  ← api, web, worker
└── packages/              ← contracts, domain, orchestrator, executors, …
```

`docs/evidence/` holds investigation write-ups (e.g. `ai-app-builder-loop-architecture.md`). Research and diagnosis output belongs there, not in `docs/adr/` — ADRs record decisions, evidence records findings.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (local Supabase per project) — but worth reopening because…_

This matters here: several ADRs are already superseded (0006 by 0007), and the roadmap has outrun some of the rest. Say so rather than quietly diverging.
