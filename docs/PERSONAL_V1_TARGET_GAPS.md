# Personal Builder v1 target gaps

The consolidated implementation specification is [Personal Builder v1: approved PRD to accepted local and cloud application](superpowers/specs/2026-08-19-personal-builder-v1-prd-to-cloud-spec.md). The Product Contract, PRD Standard, Supported Application Envelope, and ADRs 0071–0080 define the accepted target; current source does not yet implement that target end to end.

| Current implementation | Accepted target | Required migration slice |
| --- | --- | --- |
| Generated `apps/api` scaffold uses Fastify and accepts service-role configuration. | Generated Backend API uses Hono on Node and Workers; runtime is caller-scoped only. | Replace the generated HTTP scaffold and credential contract while leaving the Agent Foundry control API on Fastify. |
| Generated runtime identity is primarily `projectId`, and accepted/candidate/manual database environments are not first-class. | Run Candidate, Candidate Supabase Stack, Local Supabase Stack, and Manual Preview Stack have distinct durable identities. | Make environment identity explicit and move stack promotion behind Local Acceptance. |
| Task Graph execution integrates accepted task work into the primary checkout. | Accepted Vertical Tasks advance only the Run Candidate; primary moves once at Local Acceptance. | Redirect task integration and verification to the candidate lineage. |
| Generation intake and harness still contain idea-first, VPS, upload, password-reset, and service-role assumptions. | Standard PRD input, Cloudflare Workers, no uploads, no password reset, caller-scoped runtime. | Migrate intake validation and the versioned harness/scaffold; keep transition warnings until replacement is complete. |
| No trusted Cloudflare/Supabase publication controller implements the Publication Gate. | Free-only Cloud Publication provisions, backs up, migrates, deploys, verifies, and preserves partial inventory. | Add provider preflight and trusted publication lifecycle outside Task Agent authority. |
| Current execution relies on CLI permission modes and workspace checks but does not prove the full deny-by-default capability boundary. | Task Agents see only scoped worktree, temp, provider auth, approved origins, and exact local services. | Enforce and acceptance-test filesystem, process, Docker, and network capabilities. |
| Existing acceptance evidence does not prove the complete new golden journey. | Issue Radar Lite passes real local and cloud auth, CRUD, persistence, RLS, isolation, cleanup, browser, and database evidence. | Build one end-to-end acceptance campaign at the Promotion Commit; no broader app matrix in v1. |

## Closure boundary

The remaining product choices are closed. Implementation is not complete until Issue Radar Lite proves the complete PRD-to-local-to-cloud path with real provider sessions and accepted evidence. Do not create implementation issues or broaden the milestone without operator approval.
