# ADR 0072: Agent Foundry provisions and gates Cloud Publication

- Status: Accepted
- Date: 2026-08-18
- Owners: Core, Integrations, Safety
- Builds on: ADR 0071

## Context

Cloud Publication must remain operable by one trusted owner without manual dashboard steps, while keeping provider credentials and irreversible production actions outside Task Agent authority. Publication also needs a precise boundary between reversible application code and forward-only database changes.

## Decision

After explicit operator approval, Agent Foundry provisions or updates the Generated Application's two Cloudflare Workers and its dedicated Cloud Supabase Project. The first release uses provider-assigned `workers.dev` addresses; custom domains and DNS automation are deferred.

Personal Builder v1 provisions only resources available on Cloudflare Workers Free and Supabase Free. It never accepts a charge, upgrades a plan, pauses or deletes another project, or creates synthetic traffic to preserve free-tier activity. Provider preflight blocks when a required resource is unavailable without payment. In particular, a third active Supabase Free project is blocked and the operator is shown the existing capacity and provider actions; the Workers Free limit of 100,000 requests per day is shown as a provider ceiling, not converted into an automatic upgrade.

Cloudflare and Supabase authentication uses the providers' official interactive CLI login outside the Project Directory. Agent Foundry's Environment Preflight verifies those sessions but never copies their tokens into its project database, Git, Task Agent prompts, generated artifacts, screenshots, or logs. Task Agents may prepare source and configuration, but only Agent Foundry's trusted publication path may invoke the authenticated CLIs.

Resource names derive from an operator-editable application slug plus a stable eight-character project suffix. Cloudflare Workers use `<slug>-<project-suffix>-web` and `<slug>-<project-suffix>-api`; the Cloud Supabase Project uses the same stable identity. V1 uses the Cloudflare account already active as the official CLI's default instead of presenting an account selector. Before creating anything, Agent Foundry shows that exact account, the Worker and Supabase names, organization, and target region for approval.

The operator chooses the Cloud Supabase Project region before creation, normally nearest the application's primary users. Region is immutable for that resource; changing it requires a new project and explicit data migration. V1 has no cloud staging environment: workerd is the pre-production target, followed by the approved production publication.

The Publication Gate runs deterministic tests and the production build locally, previews both Workers in workerd, then shows one exact publication plan covering provisioning, backup, migrations, deployment, accounts, region, free plans, resources, provider ceilings, and any paid blocker. Operator approval authorizes that free plan; routine steps inside it do not pause again. Agent Foundry then publishes and proves the real login, CRUD, persistence, and cross-user isolation journeys without enabling public signup. Any failed stage prevents acceptance. A changed plan requires a new approval.

First publication performs Cloud Owner Enrollment. The local Agent Foundry UI asks for the owner email and a password of at least 12 characters, uses a temporary Stack Administration Capability to create the confirmed user server-side, and clears the values immediately. The password never enters durable state, logs, artifacts, screenshots, prompts, environment files, or the Standalone Repository. Public signup is disabled before acceptance. A later publication preserves the same owner and never recreates or changes it. A missing owner blocks publication; credential loss requires an explicit provider-side intervention or separately approved destructive recreation because v1 has no password-reset path.

Cloudflare Workers Logs remain enabled after publication with 100% sampling of application-authored structured logs. Automatic invocation logs are disabled because they include request URLs. Generated logs contain only request ID, normalized route, status, and duration under ADR 0071's redaction contract.

Cloud Publication transfers code, approved migrations, Auth configuration, and non-secret application configuration only. It never copies local Auth users, sessions, Verification Data, or business records. A new Cloud Supabase Project starts empty; remote smoke checks create disposable users and records and must remove them before publication is accepted. Cleanup failure blocks acceptance and identifies the remaining remote data.

Publication is pinned to the Promotion Commit recorded by Local Acceptance. Agent Foundry builds it in an isolated worktree at that exact commit, so an Externally Modified Project cannot leak later manual edits into the deployment. A missing commit, changed committed lockfile, repository corruption, or output not reproducibly built from that commit blocks publication. Agent Foundry never resets the operator's workspace or promotes "whatever is currently on disk."

Before provisioning, Agent Foundry shows the provider account, organization, region, resource names, selected free plans, provider ceilings, and any action that would require payment and requires explicit confirmation. Any paid requirement blocks rather than appearing as an approvable charge. Unpublishing or Project Detachment leaves cloud resources intact. Cloud Destruction targets one named Worker, Supabase project, or backup at a time and requires typing the application slug; partial publication failure records its exact inventory and never deletes resources automatically.

A failed update leaves the previously accepted cloud version live. Agent Foundry records the partial inventory and offers explicit resume or Cloud Destruction; it never routes traffic to an unaccepted version or performs automatic cleanup.

Application Rollback republishes a previously accepted application version. Database migrations remain forward-only. Before applying any cloud migration, the Publication Gate creates a Cloud Logical Backup and verifies its checksum and manifest. It stores that dump under the Foundry Data Directory because Supabase Free does not provide downloadable dashboard backups. Local destructive database operations require either a recent verified backup or an explicit operator waiver. Restore always remains a separate, explicitly approved operation.

The three most recent Cloud Logical Backups are retained for 30 days. Earlier deletion requires explicit confirmation; retention expiry may remove only a backup that is neither protected nor needed by an active restore.

Agent Foundry never keeps a Cloud Supabase Project active with synthetic requests. Supabase status `540` is classified as Cloud Data Paused: the generated application returns a bounded `503`, and Agent Foundry shows the exact provider project and Studio resume link without spending a model call or attempting an automatic resume.

## Consequences

Cloud Publication normally requires no manual Cloudflare or Supabase dashboard workflow after their CLIs are authenticated. Free-project capacity, a provider-paused project, or lost owner credentials may require an explicit provider-side action. Publication cannot silently choose or create resources, spend money, keep a free project alive artificially, configure a custom domain, expose secrets to a Task Agent, migrate without a verified backup, reverse a migration, or call a deployment successful before the post-publication evidence passes.
