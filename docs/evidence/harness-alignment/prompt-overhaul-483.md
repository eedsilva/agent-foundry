# Per-role system-prompt overhaul — #483

**Date:** 2026-08-11
**Ticket:** [#483](https://github.com/eedsilva/agent-foundry/issues/483) (part of Epic HA-D [#472](https://github.com/eedsilva/agent-foundry/issues/472), unblocked by the capability spike [#482](https://github.com/eedsilva/agent-foundry/issues/482) — `docs/evidence/harness-alignment/cli-capabilities.md`)
**Branch / commit:** `feat/483-per-role-prompt-overhaul`, real-mode A/B run against HEAD `1be1241`

**Bottom line.** Five of the six agent roles (`planner`, `developer`, `plan-reviewer`, `code-reviewer`, `tester`) now get a short, versioned, role-specific system prompt injected through each CLI's real always-applied instructions surface (Claude's `--append-system-prompt`, Codex's `developer_instructions` config override), on top of — not replacing — the existing per-task `harness/roles/*.md` content. The mock-mode regression net (golden-path substitute, per the plan's Global Constraints) is green. One real-mode A/B tracer comparison exercised the **planner** role specifically (the other four roles' new prompts were not exercised in a real CLI call this session — see Scope below) and surfaced one concrete, positive, citable difference: the new-prompt run's plan preserved existing regression coverage (`browser-tests/cross-tenant-denial.json` + smoke-script auth assertions) that the baseline run's plan explicitly deleted. **This is a real observation, not a manufactured one — but at n=1 per side, with no sampling control, causal attribution to the new system-prompt content is not established.** The new `planner.md` system prompt does not contain any rule about preserving pre-existing tests or scaffold code; its closest relevant rule ("The PRD's stated exclusions are binding") is satisfied equally by both plans. The difference could be normal Claude Opus run-to-run variance on a judgment call neither plan's system prompt addresses. Reported plainly per this branch's own Global Constraints ("if the two runs show no measurable difference... report that plainly rather than manufacturing an improvement") — this result is stronger than "no difference," but weaker than "the new prompts caused a defect fix."

---

## 1. Which five roles, and why

The ticket's own vocabulary ("planner/developer/reviewer/verifier") is loose product language, not the schema. The plan's Global Constraints resolved this once: the real, only role enum is `AgentRoleSchema` (`packages/contracts/src/primitives.ts:32-41`): `planner, plan-reviewer, developer, code-reviewer, fixer, tester`. This work targets exactly the five the ticket names — reviewer → both reviewer roles (`plan-reviewer`, `code-reviewer`), verifier → `tester` — leaving **`fixer` out of scope** (not named in the ticket's four-role vocabulary; its behavior does not change). Absence of a `fixer.md` template file is the mechanism for that exclusion — `SystemPromptRepository.select('fixer')` resolves to `undefined`, and both executors treat "no template" as "inject nothing," so no special-casing exists anywhere in executor code.

Each role's template lives at `harness/system-prompts/<role>.md`, versioned by a single `harness/system-prompts/manifest.json` (`{ "version": "2026.08.11-v1" }`, unchanged since Task 1). Each file's own frontmatter comment cites the CLI surface it targets (see §2). Content is short and directive by design — non-negotiable identity/behavior rules meant to hold even if the larger per-task `REQUEST.md` content is truncated or ignored — not a restatement of the existing `harness/roles/*.md` task-content layer, which remains untouched and still delivered via `VersionedHarnessRepository` as user-message content.

## 2. Which CLI surface each role uses

Both CLIs' surfaces are the ones the capability spike (#482) verified as the real, functional "always-applied instructions" mechanism — not the project-doc-level `AGENTS.md`/`CLAUDE.md` layer, which loads with lower reliability (`cli-capabilities.md` §1: "CLAUDE.md is delivered as a user message after the system prompt, not as part of the system prompt itself").

- **Claude** (`packages/executors/src/claude-executor.ts`): `--append-system-prompt <content>`, passed as a separate `execa` argv element (no shell escaping needed). `cli-capabilities.md` §1 (lines ~84-93): "the docs' own recommendation for system-prompt-level, always-applied instructions in automation is `--append-system-prompt`, which 'must be passed every invocation.'"
- **Codex** (`packages/executors/src/codex-executor.ts`): `-c developer_instructions='''<content>'''` — a TOML literal string via the `-c key=value` config-override flag. `cli-capabilities.md` §2c-bis (lines ~136-148): `developer_instructions` is Codex's real functional analog to `--append-system-prompt` ("Developer instructions inserted as a `developer` role message... an always-applied instructions block injected as a distinct message role"). #482's spike prototype-verified a basic double-quoted `developer_instructions="..."` string; this branch ships a *multi-line TOML literal string* (`'''...'''`) instead, needed because role content spans multiple lines and literal strings need no escaping. That specific encoding was not covered by #482's original prototype, so the final whole-branch reviewer verified it live against the real binary: `codex exec --sandbox read-only -c "developer_instructions='''…multi-line…'''" "Say hello."` (codex-cli 0.146.1) was accepted and obeyed (the model followed the injected instruction rather than just greeting). `instructions` is explicitly dead ("Reserved for future use") and `model_instructions_file` is upstream-discouraged full-replace — this work uses neither, per §2c-bis's own reading.

Both call sites are byte-for-byte unchanged from pre-#483 behavior when a role has no template (`fixer`) or no `SystemPromptRepository` is injected — the new field (`AgentExecutionRequestSchema.systemPrompt`, optional) is additive.

## 3. Mock-mode regression net — substitution and result

Per the plan's Global Constraints, no test in this repo is literally a "TODO/Issue Radar journey" that runs in mock mode against the prompt-compiler/request-shape path. The substitute, stated explicitly here for reviewer visibility:

- `packages/composition/src/task-execution.integration.test.ts` (part of `test:unit:slow`) — exercises the full plan→approve→implement loop against `MockAgentExecutor`, so it's the closest real mock-mode coverage of prompt-compiler/request-shape changes.
- `npx tsx scripts/tracer.ts --scenario toy --executor-mode mock` — an end-to-end smoke check, per the precedent in `docs/evidence/harness-alignment/scenario-4-proof.md`.

Both ran clean on this branch (HEAD `1be1241`, includes Task 1 + Task 2 + Task 3 step 0):

```
$ npx vitest run packages/composition/src/task-execution.integration.test.ts

 ✓ packages/composition/src/task-execution.integration.test.ts (2 tests) 8826ms
   ✓ for-each-task execution > runs each task in dependency order and commits it on its own  4184ms
   ✓ for-each-task execution > resumes a paused graph at the first incomplete task  4642ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

```
$ npx tsx scripts/tracer.ts --scenario toy --executor-mode mock

toy: project 01KZRWE24CT6EDX62F7AD4WHGM, run 01KZRWE24CKTV1QJACGQ0YGNXK → awaiting_approval
```

Matches `scenario-4-proof.md`'s documented shape exactly (`<scenario>: project <id>, run <id> → awaiting_approval`) — the tracer still short-circuits cleanly at the plan-approval gate, with no scenario-identity branching anywhere in the runner.

Full unit suite (`npm run test:unit:fast`, 167 files / 1497 tests) and `npx tsc -b` were also run clean against every step-0 code change (see Task 3 report for detail); not part of the ticket's golden-path substitution but recorded as additional evidence the change didn't regress anything else.

## 4. Real-mode A/B — method

Two real, single-step tracer runs of the `toy` scenario (`examples/tracer/scenarios/toy.json`), controller-executed (worktree tooling not available to this agent):

| | Baseline | New |
|---|---|---|
| Checkout | disposable worktree at commit `d7e3f40` (origin/main post-#507, pre-#483 — no system-prompt injection wired up at all) | this branch, HEAD `1be1241` (Task 1 + Task 2 + Task 3 step 0) |
| Model | `claude-opus` (planner role) | `claude-opus` (planner role), same routing table (`web-app-v1` / `planning`), `attemptedModelIds: ["claude-opus"]`, no fallback |
| Method | created a project from the toy PRD, ran `worker.runOnce()` (executes exactly the `plan` step), captured the resulting `plan.current` artifact | identical |
| Result | reached `awaiting_approval` cleanly, no errors, no retries | reached `awaiting_approval` cleanly, no errors, no retries (`.scratch/483-tracer-ab/new-result.json`) |

Raw evidence in this worktree: `.scratch/483-tracer-ab/new-result.json` (run/step metadata) and the full `plan.current` artifact under `.scratch/483-tracer-ab/new-data/projects/01KZRYSAEHSRF5TKKH2QJBG4SN/artifacts/plan.current/000001.json` (both gitignored via the `.scratch/` entry from #482, not committed). The baseline side's equivalent artifact lived in a disposable sibling worktree (`483-baseline-tracer`) that is not guaranteed to still exist by the time this doc is read; the baseline quote below is preserved verbatim from the controller's run report rather than re-read from that worktree.

Both plans are structurally strong — real requirements, real acceptance checks, real risk sections, no vacuous or templated-looking content. This is not a "one run is broken" comparison.

## 5. The comparison

The toy PRD is explicit: no auth. But the scaffold both runs plan against ships a full auth demo (sign-in/sign-up, seeded accounts, `browser-tests/cross-tenant-denial.json`, auth assertions in `scripts/smoke.mjs`). The two plans resolve that PRD-vs-scaffold tension differently.

**Baseline plan**, `content.decisions[0]` (verbatim, per controller report): "Delete the sign-in/sign-up pages, apps/web/middleware.ts, apps/web/lib/supabase/server.ts, the API tier's authenticated route scope, the seeded accounts, browser-tests/cross-tenant-denial.json, and the auth assertions in scripts/smoke.mjs." Its own risk list acknowledges: "The platform's shipped cross-tenant-denial browser test and the smoke auth-path checks no longer apply and are removed; nothing in the app asserts tenant isolation because there are no tenants." Flagged as non-blocking open question Q1, `planDefault: Delete it`.

**New plan**, `content.decisions[0]` (verbatim, read directly from `.scratch/483-tracer-ab/new-data/.../plan.current/000001.json`, this worktree): "Serve the public counter page at / and relocate the existing session-gated items page to /items, updating the sign-in/sign-up redirects and the cross-tenant-denial browser test to match." Its assumptions state: "The scaffold's auth machinery is retained as platform plumbing rather than a product feature; no PRD capability depends on it." `browser-tests/cross-tenant-denial.json` and the auth-path smoke checks survive, retargeted at `/items` instead of deleted. The new plan's own risk list names the alternative explicitly: "Relocating the home page without updating apps/web/app/actions.ts and browser-tests/cross-tenant-denial.json together leaves the tenancy test passing on a page it no longer reaches, so it would stop proving the boundary" — i.e. it identifies the same hazard the baseline plan's Q1 accepted, and resolves it by preserving the test rather than deleting it.

**The concrete, positive, citable difference:** the new plan preserves an existing regression check (`cross-tenant-denial.json` + smoke auth assertions) that the baseline plan's own self-identified risk admits deleting is dangerous ("If any platform-level check outside this workspace expects those artifacts to exist... it will fail even though the app matches the PRD" — baseline plan, per controller report). Loosely mapped to `defect-list.md`'s existing taxonomy, this sits in the same family as that list's #2 (an orchestration-adjacent decision that discards a correct verification signal) — here, at the planning stage rather than at runtime, and avoided rather than hit.

**The honest limitation on attribution.** `harness/system-prompts/planner.md` (the new content actually injected this run) is four short rules: PRD exclusions are binding; every task must be independently checkable; operator-only decisions go in open questions verbatim; breadth without acceptance checks is not a plan. None of these say anything about preserving pre-existing tests or scaffold code that the PRD doesn't mention. The closest applicable rule — "The PRD's stated exclusions are binding" — is satisfied equally by both plans: neither plan adds a PRD-excluded feature; they differ only on what happens to pre-existing, PRD-unrelated scaffold code, a question the new system prompt is silent on. With n=1 real run per side, Claude Opus, no fixed seed, ordinary sampling variance on an underspecified judgment call is a fully sufficient alternative explanation for this difference. **This report does not claim the new system-prompt surface caused the better outcome** — only that a better outcome was observed, on one axis, in one comparison, with the causal question genuinely open.

## 6. Scope of what was actually exercised

The workflow pauses at the plan-approval gate after one `worker.runOnce()`. No gate-auto-approval driver was built (out of scope per the plan — "building new judge/scoring infrastructure" is explicitly excluded), so **only the `planner` role's new system prompt was invoked in a real CLI call this session.** `developer`, `plan-reviewer`, `code-reviewer`, and `tester`'s new templates exist, are unit-tested (Task 1/2 loader + wiring tests), and are wired into both executors identically to `planner`'s — but their real-mode behavior with the new prompt injected has not been observed in this A/B. This doc makes no claim about them beyond "wired and unit-tested."

## 7. Outcome against the ticket's acceptance bar

The ticket's bar: "measurably better on at least one tracer defect class." Result: **a real, concrete, positive difference was observed** (existing regression coverage preserved vs. deleted, on the one PRD-vs-scaffold judgment call this toy scenario happened to surface) — **but causal attribution to the new system-prompt surface is not established at n=1.** This is not "no measurable difference" (a difference was measured and is citable), and it is not "the new prompts fixed a defect" (the new prompt's own content doesn't address the axis where the difference showed up, and one run per side cannot rule out ordinary variance). Reported at the confidence the evidence actually supports, per this branch's own Global Constraints and `CONTRIBUTING.md`'s "a green compiler alone is not evidence."

**What a stronger comparison would need**, named as a follow-up, not built here (out of scope per the plan):
- Multiple runs per side (e.g. n=5) on the same scenario, to separate a system-prompt effect from Opus sampling variance on this specific judgment call.
- A heavier scenario (e.g. `crud-heavy`) that reaches further into the plan — the `toy` scenario's cheapness is exactly why it stopped at one judgment call the planner prompt doesn't address; a bigger PRD surface has more chances to hit rules the new prompts *do* encode (e.g. "every task independently checkable," which `toy`'s single-decision plan didn't meaningfully stress).
- A run that reaches past the plan-approval gate (auto-approval or a manual approve step), to exercise `developer`, `plan-reviewer`, `code-reviewer`, and `tester`'s new system prompts in a real CLI call — currently zero real-mode evidence exists for those four roles.

## 8. Boundaries of this evidence

- **n=1 per side, one operator/controller session, one scenario, one role exercised.** Not a statistically powered comparison on any axis.
- **No fixed seed / no sampling control.** Claude Opus's ordinary run-to-run variance is not distinguished from any effect of the new system prompt anywhere in this report.
- **Only the plan-approval-gate portion of one run reached a real CLI invocation.** `developer`/`plan-reviewer`/`code-reviewer`/`tester` roles' new prompts are unit-tested but not real-mode-observed.
- **The baseline run's raw artifact lives in a disposable worktree** (`483-baseline-tracer`) not guaranteed to survive past this session; its plan content here is quoted verbatim from the controller's run report, not independently re-read by this agent from the source file.
- **No UI-quality judge score applies** — the `toy` scenario stopped at the plan-approval gate in both runs, before any UI existed to score.
- **The per-attempt evidence artifact (`requestMarkdown`, capped at 50k) does not record the injected system prompt.** Reconstructing exactly what an agent saw for a given historical run means checking out the `harness/system-prompts/` tree at the version recorded alongside it in run-pause snapshots (`systemPromptVersion`, mirroring the existing `harnessVersion` audit field — `packages/contracts/src/run.ts`) — the content itself isn't logged per-attempt, only referenced by version.
