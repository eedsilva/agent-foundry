# Real-mode validation tickets

Small tickets for the staged validation run. The first four were already on
`origin/main`; this branch adds the two control-plane fixes. The remaining
tickets are real-provider validation slices, not new mock test fixtures.

| Ticket | Scope | Status | Evidence |
| --- | --- | --- | --- |
| RV-01 | Strip Claude-incompatible `$schema` and top-level `x-*` metadata. | Done on base | `packages/executors/src/claude-executor.ts` |
| RV-02 | Keep preview optional dependencies native to the host. | Done on base | `packages/executors/src/docker-preview-installer.ts` |
| RV-03 | Bound preview install pressure and tolerate Docker cleanup races. | Done on base | installer/sandbox runner tests |
| RV-04 | Defer database smoke scripts until the full-suite node. | Done on base | `workflows/web-app-v1.yaml` |
| RV-05 | Replay a failed step without reprovisioning the generated runtime. | Done here | `project-service.test.ts` regression |
| RV-06 | Renew an active preview lease during long workflow work. | Done here | `preview-service.test.ts` regression |
| RV-07 | Run the three-task TODO tracer bullet and prove reload persistence. | Done manually; workflow browser gate blocked | project/run IDs, visible browser, Supabase REST row |
| RV-08 | Run the appointment schema/API/UI vertical slice. | Blocked by RV-07 browser-proxy failure | database row plus visible browser |
| RV-09 | Add edit, legal status, finalize, filters, and deletion. | Not started | focused gates before final flow |
| RV-10 | Run the complete visible happy path once and capture evidence. | Not started | run/project IDs, UI, backend |
| RV-11 | Preserve terminal preview lifecycle errors before browser-report binding. | Done here | `browser-verification-coordinator.test.ts` regression |
| RV-12 | Declare the Next.js runtime helper directly in the generated web package. | Done here | scaffold package/lock plus harness test |
| RV-13 | Reject non-function exports from generated `'use server'` modules before browser verification. | Done here | scaffold gate and focused harness tests |

RV-04 is also the repair boundary: Docker-backed smoke is not handed to a
repair agent that cannot reproduce it. If the full-suite verifier cannot run
Docker, the run remains failed/blocked with the exact diagnostic; no new Bugs
issue is created unless that failure is reproduced as a product defect.
