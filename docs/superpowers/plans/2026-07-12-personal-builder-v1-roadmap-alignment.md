# Personal Builder v1 Roadmap Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align repository documentation and the live GitHub roadmap with the approved local-first, full-stack Personal Builder v1 contract.

**Architecture:** Keep `planning/roadmap-spec.json` as the structural source of truth and derive the rendered roadmap and managed GitHub issues through existing scripts. Add a requirement traceability artifact so product promises, milestone gates, tasks, and evidence can be checked together.

**Tech Stack:** Markdown, JSON roadmap specs, Node.js roadmap validators/renderers, GitHub Issues/Milestones/Projects, `gh`, Docker Compose, Supabase, Next.js, Caddy.

## Global Constraints

- Personal v1 control plane runs on macOS and loopback for one trusted operator.
- Generated applications use Next.js, TypeScript, Tailwind CSS, shadcn/ui, and one isolated local Supabase Docker stack per project.
- V1 is greenfield-only and uses local Git as source of truth.
- Production targets an existing Ubuntu LTS VPS over SSH; Debian hosts are best-effort compatible.
- Vercel, Supabase Cloud, OAuth, SMTP, cloud provisioning, automatic DNS changes, automatic database rollback, and image generation are outside v1.
- Every build uses the full multi-agent pipeline and adaptive routing across Codex, Claude, and AGY.
- Every successful operation creates one verified Git commit; failed work remains on a draft branch.
- Emergency execution ceiling is four hours or ten consecutive repair cycles.
- Issue Radar is the canonical release application.

---

### Task 1: Publish the authoritative product contract

**Files:**

- Modify: `docs/PRODUCT_CONTRACT.md`
- Create: `docs/PERSONAL_V1.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: approved design in `docs/superpowers/specs/2026-07-12-personal-builder-v1-design.md`.
- Produces: normative v1 requirements used by architecture, roadmap, and traceability.

- [ ] Replace the contradictory v1 finish line with the full local builder, Supabase, VPS publish, and rollback boundary.
- [ ] Record all explicit non-goals and post-v1 platform sequence.
- [ ] Update README positioning from batch PRD pipeline to current baseline plus target golden journey.
- [ ] Run `rg -n "Vercel|Supabase Cloud|existing repositor|publish.*post-v1|full-stack.*post-v1" README.md docs planning` and resolve contradictory normative statements.

### Task 2: Align architecture and operational contracts

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOYMENT_PROFILES.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/RISK_REGISTER.md`
- Modify: `docs/adr/0006-managed-backend-adapters.md`
- Create: `docs/adr/0007-local-supabase-per-project.md`
- Create: `docs/adr/0008-existing-vps-compose-deployment.md`

**Interfaces:**

- Consumes: normative contract from Task 1.
- Produces: component boundaries and security/operations constraints used by roadmap tasks.

- [ ] Add generated-project runtime, local Supabase lifecycle, deployment, backup, and Git/version boundaries to architecture.
- [ ] Define `personal-local-builder` and `personal-vps-app` profiles without treating the VPS as Agent Foundry hosting.
- [ ] Document `.env` trust limitations, SSH boundary, forward-only migrations, and approved restore workflow.
- [ ] Supersede ADR 0006 and record the local Supabase and existing-VPS decisions in new ADRs.
- [ ] Add risks for `.env` leakage, backup loss, migration/rollback mismatch, SSH bootstrap, and per-project resource exhaustion.

### Task 3: Restructure the roadmap into vertical golden-path releases

**Files:**

- Modify: `planning/roadmap-spec.json`
- Modify: `planning/project-spec.json` only if view/filter text must change.
- Modify: `planning/DELIVERY_FOUNDATION_REPORT.md`

**Interfaces:**

- Consumes: product and architecture contracts from Tasks 1-2.
- Produces: validated milestone/task DAG consumed by renderer and GitHub reconciler.

- [ ] Remove `v0.4 - Existing Repositories` from the Personal v1 dependency chain and mark it post-v1.
- [ ] Make Live Preview independent of existing-repository import and dependent on Reliable Runs plus Safe Runtime.
- [ ] Make Conversational Builder depend on Human Control and Live Preview.
- [ ] Rewrite Full-stack App Platform around isolated local Supabase Docker, default email/password auth, manual password reset, RLS, storage, functions, and `.env` secrets.
- [ ] Rewrite Publish and Integrations around existing-VPS SSH deployment, Docker Compose, Caddy, optional manual-DNS domains, backups to Mac, application-only rollback, and optional GitHub.
- [ ] Restore Full-stack and Publish as v1 milestone dependencies.
- [ ] Add or repurpose tasks so every Issue Radar release assertion has a single accountable issue and evidence requirement.
- [ ] Add post-v1 milestones for Linux/browser-editor/existing-repository support and later Windows support without conflating them with Hosted Platform v2.

### Task 4: Add machine-checkable product traceability

**Files:**

- Create: `docs/PERSONAL_V1_TRACEABILITY.md`
- Modify: `scripts/validate-roadmap.mjs`
- Modify: `scripts/lib/roadmap.mjs`
- Modify: `scripts/lib/roadmap.test.mjs`
- Modify: `package.json` only if a separate validation command is needed.

**Interfaces:**

- Consumes: requirement identifiers in product docs and task keys in roadmap spec.
- Produces: validation failure when a normative v1 requirement lacks roadmap/test/evidence coverage.

- [ ] Define stable requirement IDs for product, runtime, full-stack, visual editing, Git, deployment, backup, security, and non-goals.
- [ ] Map every requirement to milestone keys, task keys, acceptance evidence, and Issue Radar assertions.
- [ ] Add validator fixtures proving missing task references, missing release evidence, and forbidden v1 dependencies fail.
- [ ] Run `npm run roadmap:check` and confirm the traceability checks pass.

### Task 5: Render and reconcile GitHub

**Files:**

- Regenerate: `planning/ROADMAP.md`
- Modify through reconciler: `planning/github-state.json`

**Interfaces:**

- Consumes: validated roadmap spec and current live issue state.
- Produces: live milestones, epics, tasks, parent/sub-issue links, and blocker links.

- [ ] Run `npm run roadmap:render`.
- [ ] Run `npm run github:roadmap:dry-run` and inspect counts for new and retired records.
- [ ] Review live-body drift before applying; do not use `--force-drift` without inspecting the conflicting issue.
- [ ] Run `npm run github:roadmap:apply`.
- [ ] Explicitly close or annotate genuinely retired issues because the reconciler reports removed keys but does not close them automatically.
- [ ] Verify the root roadmap, every changed epic, every new task, milestone assignment, labels, sub-issue parent, and blocker relationship through live GitHub reads.

### Task 6: Validate the complete alignment

**Files:**

- Modify: `docs/VALIDATION.md`

**Interfaces:**

- Consumes: all preceding artifacts and live GitHub state.
- Produces: dated evidence record and calibrated planning-confidence statement.

- [ ] Run `npm run check`.
- [ ] Run `git diff --check`.
- [ ] Search all docs/planning files for rejected assumptions and stale issue/task counts.
- [ ] Compare every traceability row against the live issue number and state.
- [ ] Record exact commands, pass/fail counts, remaining implementation risks, and why planning coverage is at least 95% or which gaps prevent that claim.
