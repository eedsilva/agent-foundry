# ADR 0077: The terminal-launched control plane has an authenticated local session

- Status: Accepted
- Date: 2026-08-18
- Owners: Core, Product, Safety

## Context

Personal Builder v1 runs on one trusted Mac. The current development shape launches separate web, API, and worker processes, binds the API to loopback, and defaults `DATA_DIR` to `.data` inside the repository checkout. Loopback prevents remote binding by default but does not authenticate browser requests: another page open on the same Mac can still attempt localhost requests. Checkout-relative durable state also couples user data to source updates and Git operations.

Packaging and signing a macOS application before the golden journey passes would add distribution work without improving generation correctness. The first release still needs a clear launch, session, state, backup, and migration contract.

## Decision

V1 installation is a source checkout followed by `npm ci`; it ships no Homebrew formula, binary, signed `.app`, login item, or automatic startup. One `npm run foundry` command runs Environment Preflight, starts the control API, worker, and web UI, and opens the browser.

Updates are explicit and require a stopped control plane, no active run, and a clean Agent Foundry checkout. The documented path is `git pull --ff-only`, `npm ci`, Environment Preflight, an Internal State Snapshot, and a preview of any forward-only internal migration before startup. A failed precondition or migration leaves the previous checkout and state usable. Update checks may notify but never install anything.

Web, API, and worker remain loopback-only. On startup Agent Foundry creates or loads an installation secret with owner-only filesystem permissions and opens a one-time bootstrap URL. Successful bootstrap creates a process-lifetime Control Session using an HttpOnly, SameSite cookie; every state-changing request also requires CSRF protection. Restarting Agent Foundry requires a new bootstrap. A loopback request without a valid session is unauthorized. Preview Session tokens remain separate and cannot authorize control-plane routes.

Multiple tabs may share the same Control Session. Every state mutation and approval carries the state revision it observed. The first valid decision advances that revision; a stale tab receives a Revision Conflict and must reload before deciding again.

The first termination signal begins Graceful Shutdown: active execution pauses at a durable boundary, its work remains a Preserved Draft, Agent Foundry-owned child processes stop, and Preview Sessions plus local Supabase services stop without deleting their data. If shutdown remains incomplete after 30 seconds, Agent Foundry reports the exact pending processes and keeps waiting; it never escalates automatically. A second termination signal is an explicit emergency stop and may skip orderly process cleanup, but cannot erase persisted state.

The default Foundry Data Directory is `~/Library/Application Support/Agent Foundry`. An alternate absolute directory may be selected only before first initialization. It never lives inside the Agent Foundry checkout or a Project Directory.

Agent Foundry provides explicit export and restore for its internal state, non-secret configuration, artifacts, and evidence. The export excludes Standalone Repositories and cloud backups, which retain their own recovery paths. Before any internal schema or layout migration it creates and verifies an Internal State Snapshot, then applies a forward-only migration. Existing valid state is migrated; failure preserves the snapshot and old state and never silently resets. It retains the three newest Internal State Snapshots; deleting one earlier requires confirmation. V1 provides no scheduled internal backup.

At-rest protection relies on owner-only filesystem permissions, provider credential stores, and the operator's FileVault configuration. Environment Preflight warns when FileVault is unavailable or disabled but does not block operation or invent application-level encryption for all local state.

The onboarding disclosure identifies the Provider Data Boundary: approved PRD content and necessary source context are sent to Anthropic for Haiku work and OpenAI for Luna work. The operator confirms that boundary before enabling real Task Agents.

## Alternatives considered

- **Signed macOS application now.** Deferred until the terminal-launched golden journey is accepted; signing, notarization, background services, and updater behavior are separate delivery work.
- **Trust any loopback request.** Rejected because browser-origin attacks can target localhost even when the API is not remotely bound.
- **Keep durable state under the checkout.** Rejected because source cleanup, branch changes, and upgrades should not endanger operator data.
- **Encrypt the entire state tree with a custom scheme.** Rejected because it adds key lifecycle and recovery risk while FileVault and strict permissions cover the first trusted-owner profile.

## Consequences

Current startup, API middleware, configuration defaults, migration tooling, and onboarding must change. Development remains command-driven, but the UI gains a real local trust boundary. Moving existing `.data` requires a snapshot-backed migration or explicit import; deleting it is not migration.

The installation secret is security-sensitive and never enters logs, diagnostics, prompts, Git, or exports. Losing both the Foundry Data Directory and its snapshots loses Agent Foundry history but does not make Standalone Repositories unusable.

## Validation and rollback

Acceptance covers source installation, explicit clean-checkout update, single-command startup, remote-bind rejection, missing/invalid/expired session rejection, process-lifetime expiry, CSRF, bootstrap replay, cookie attributes, preview-token isolation, multi-tab Revision Conflicts, bounded Graceful Shutdown reporting, explicit emergency stop, owner-only secret permissions, paths with spaces, alternate first-run location, snapshot creation and retention, migration preview, forward migration, failed-migration recovery, bounded export/restore, existing-state migration, FileVault warning, and no silent reset.

Rollback restores the pre-migration binary and verified Internal State Snapshot. Do not point an older binary at already-migrated state unless its schema version explicitly supports it.
