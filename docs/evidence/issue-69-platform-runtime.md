# Issue #69 — isolated Supabase runtime evidence

Date: 2026-07-22

## Acceptance mapping

| Intent                         | Implemented boundary                                                                                                   | Automated evidence                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Per-project Supabase lifecycle | `SupabaseGeneratedProjectRuntime` owns initialize, start, stop, inspect, migrate, seed, health, reset, and cleanup     | `packages/platform/src/supabase-runtime.test.ts`                                                      |
| Isolation                      | Each project receives a distinct CLI workdir, Compose project name, Docker network, and allocated ports                | The two-project lifecycle test asserts distinct resources and all 14 host ports                       |
| Safe persistence               | `AppEnvironment` stores only validated resource metadata, public endpoints, ports, and health                          | Lifecycle fixtures include credentials in CLI output and assert that persisted metadata contains none |
| Idempotency and recovery       | Lifecycle state is persisted atomically; repeat start/stop/initialize calls are no-ops and command errors are redacted | Adapter unit tests cover idempotency, partial failure diagnostics, and recovery                       |
| Destructive operations         | Reset and cleanup require explicit confirmation and a recent independent backup                                        | Adapter tests assert both destructive gates                                                           |
| Builder integration            | Real-mode project creation initializes the runtime before persistence; mock mode remains Docker-free                   | `project-service.test.ts` and `runtime.integration.test.ts`                                           |

## Validation results

- `npm run format:check` — passed.
- `npm run lint` — passed.
- `npm run architecture:check` — passed (including its three architecture tests).
- `npm run roadmap:check` — passed.
- `npm run typecheck` — passed.
- `npm test` — 139 Vitest files passed, 9 skipped; 1,416 tests passed, 76 skipped. The script suite also passed 57/57 tests.
- `npm run build` — passed for all packages and apps, including `@agent-foundry/platform` and the Next.js web build.
- `npx playwright test --config apps/api/e2e/playwright.config.ts` — 12 passed in 45.4 seconds.
- `npm run doctor` — mock-mode environment ready. The optional AGY CLI was unavailable, so no real-provider check was claimed.
- `git diff --check main...HEAD` — passed before publication; rerun after the final commit.

## Docker-smoke status

The local Docker daemon was unavailable (`docker info` exited nonzero), and this repository has no separate platform Docker integration test file. The adapter's command boundary, isolation, lifecycle, and secret-filtering behavior are therefore covered with controlled CLI fixtures; a real Supabase Docker smoke remains a CI/host-environment follow-up rather than a claimed local result.

## Security and rollback

- CLI output may contain database URLs and JWT values, but the adapter persists neither those values nor raw command output. Diagnostics are bounded and redacted.
- Removing the composition wiring is a safe rollback: preserve `DATA_DIR/projects/<projectId>/environment/` and its independently created backups, as recorded in [ADR 0030](../adr/0030-generated-project-runtime.md).
- Controlled API E2E fixtures explicitly omit the generated runtime, preventing their fake-provider setup from silently depending on Docker while real mode retains the production default.
