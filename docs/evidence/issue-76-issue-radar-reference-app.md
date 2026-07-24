# Issue #76: Deliver Issue Radar as a full-stack reference app — evidence

Related: ADR [0037](../adr/0037-issue-radar-reference-app.md)

## Acceptance

| Acceptance criterion (roadmap `v010-fullstack-reference`)          | Implementation                                                                                                                               | Evidence                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Next.js + Tailwind + shadcn/ui + local Supabase                    | `examples/issue-radar-app/` (Next 16 App Router, Tailwind v4, shadcn/ui CLI components)                                                      | `npm run build` in Task 2                                                     |
| Email/password auth guards CRUD/filters/dashboard                  | `middleware.ts` + `lib/supabase/{client,server}.ts`, reused from `harness/scaffolds/nextjs/`                                                 | `issue-radar-golden-journey.spec.ts` sign-up assertion                        |
| Attachment via Storage + RLS policy                                | `features/attachments/actions.ts`, `app/api/attachments/scan/route.ts`, `supabase/migrations/00000000000000_agent_foundry_storage.sql` (#72) | `issue-radar-golden-journey.spec.ts` attachment-upload assertion              |
| Browser tests cover positive journeys and denied cross-user access | Two Playwright specs                                                                                                                         | `issue-radar-golden-journey.spec.ts`, `issue-radar-cross-user-access.spec.ts` |
| Code, migrations, Compose commands exportable and documented       | `examples/issue-radar-app/{Dockerfile,docker-compose.yml,supabase/migrations,README.md}`                                                     | README "Exporting and deploying" section                                      |

## Results

Run from this worktree, on this commit (see the PR — the commit that carries this evidence
document cannot reference its own not-yet-created SHA):

```bash
npm run check
npm run e2e --workspace @agent-foundry/api -- issue-radar-golden-journey.spec.ts issue-radar-cross-user-access.spec.ts
```

`npm run check` runs `format:check && lint && architecture:check && roadmap:check && typecheck
&& test && build && secrets:check`. Each sub-step's real output:

- `format:check` (`prettier --check .`): pass — "All matched files use Prettier code style!"
- `lint` (`eslint . --max-warnings=0`): pass, no warnings/errors.
- `architecture:check`: pass — "architecture ok: 12 workspaces, no forbidden edges or cycles"
  plus 3/3 `node --test` cases green.
- `roadmap:check`: pass — "roadmap ok: 16 milestones, 114 tasks, 131 managed issues", 8/8
  `node --test` cases green, `github-config:check` ok, roadmap render check in sync.
- `typecheck` (`tsc -b --force --pretty false`): pass, no errors.
- `test` (`vitest run` unit suite + `test:scripts`): **Test Files 172 (168 passed initially, 3
  skipped), Tests 1746 (1732 passed initially, 13 skipped).** One test —
  `packages/executors/src/docker-sandbox-runner.integration.test.ts >
DockerSandboxRunner (integration) > enforces allowlisted DNS and HTTP while blocking raw,
forbidden, and metadata egress` — failed on the first full-suite run with `Error response
from daemon: No such container: ...`. Root cause: this verification pass happened to run two
  full `npm run check` invocations concurrently against the same Docker daemon (an artifact of
  this task's own verification process, not of any code change), and the two runs' Docker
  sandbox integration tests raced over container lifecycle. Re-running that single file in
  isolation (`npx vitest run --pool=threads --maxWorkers=1
packages/executors/src/docker-sandbox-runner.integration.test.ts`) passed all 18/18 tests
  cleanly, confirming the failure was contention, not a regression. This file
  (`packages/executors/src/docker-sandbox-runner.integration.test.ts`) is unrelated to Issue
  Radar (`packages/executors/`, not `examples/issue-radar-app/` or any of this plan's files).
  `packages/platform/src/issue-radar-example-security-lint.test.ts` — the security-lint
  regression this plan's own Definition of Done depends on — passed on the first run.
- `build`: pass — every workspace (`platform`, `orchestrator`, `composition`, `api`, `worker`,
  `web`) built cleanly; `apps/web`'s `next build` compiled and generated its routes with no
  errors (only a pre-existing, unrelated "workspace root inferred" warning from multiple
  lockfiles).
- `secrets:check`: **failed on the first run** with a real, in-scope finding: `.env is tracked
by Git: examples/issue-radar-app/.env`. This dummy-value `.env` (local-only placeholder
  Supabase URL/anon key, committed by an earlier task "for clean builds") was tracked because
  `examples/issue-radar-app/.gitignore` had a `!.env` override un-ignoring it, contradicting
  the root `.gitignore`'s and `secrets:check`'s repo-wide "no `.env` tracked" policy. Fixed as
  part of this commit: removed the `!.env` override (`examples/issue-radar-app/.gitignore` now
  ignores `.env` like every other package), and ran `git rm --cached
examples/issue-radar-app/.env` to untrack it (the file itself is left in place on disk,
  now git-ignored, for local dev convenience — matching the README's documented
  `cp .env.example .env.local` flow, which never depended on the tracked file). Re-ran
  `npm run secrets:check` after the fix: pass — "secrets:check — no .env tracked, no known
  secret shapes found in source or client bundle." Re-verified
  `examples/issue-radar-app`'s own `npm run typecheck` and `npm run build` still succeed with
  the now-untracked `.env` still present locally.

`npm run e2e --workspace @agent-foundry/api -- issue-radar-golden-journey.spec.ts
issue-radar-cross-user-access.spec.ts` — real output:

```
Running 2 tests using 1 worker

  ✓  1 e2e/issue-radar-cross-user-access.spec.ts:34:3 › issue radar cross-user access › user B cannot see, open, or edit user A's project or issue (4.9s)
  ✓  2 e2e/issue-radar-golden-journey.spec.ts:27:3 › issue radar golden journey › signs up, creates a project, manages an issue end to end, and uploads an attachment (6.7s)

  2 passed (2.4m)
```

Net result: every `npm run check` sub-step passes (with the one real, in-scope
`secrets:check` finding fixed above, and the one flaky Docker-contention test independently
reconfirmed passing), and both Playwright specs pass.

## CI

The `issue-radar-e2e` job in `.github/workflows/ci.yml` runs both new Playwright specs
on every push/PR against `main`.

## Real gaps found and fixed during review

- `examples/issue-radar-app/.env` (dummy local Supabase placeholder values) was tracked by
  Git, via a `!.env` override in `examples/issue-radar-app/.gitignore` that contradicted the
  repo's root-level "no `.env` tracked" policy enforced by `npm run secrets:check`. Found by
  running the full verification gate for this task; fixed by removing the override and
  `git rm --cached`-ing the file. See "Results" above for full detail.

## Scope decisions

- Did not modify `harness/scaffolds/nextjs/`, wire `security-lint`'s `blocksRelease`
  into the orchestrator's release path, or build a project-export/bundling API — see
  ADR 0037 and this plan's Global Constraints for why.
- App UI copy is in English (matches the rest of this monorepo's code/docs language
  convention); the PRD itself is Portuguese, per `harness/stacks/nextjs.md`'s "user-facing
  copy follows the PRD's language" — noted here as an explicit, intentional deviation for
  a reference/example app rather than a real customer-facing generated project.
- The attachment scanner is a trivial local auto-approve (`ponytail:` comment in
  `app/api/attachments/scan/route.ts`) — there is no real malware-scanning service in v1.

## Definition of Done

- Behavior: acceptance demonstrated via the two Playwright specs, not just asserted.
- Engineering: `npm run check` (format, lint, architecture, roadmap, typecheck, unit
  tests, build, secrets scan) plus the new `issue-radar-e2e` CI job all pass.
- Safety and operations: service-role key confined to `lib/supabase/service-role.ts`
  and the scan route; every new table RLS-enabled with owner-scoped policies, checked
  by `packages/platform/src/issue-radar-example-security-lint.test.ts`.
- Delivery evidence: this document, ADR 0037, and the PR closing #76.
