# ADR 0073: The Economy Profile pins Haiku and Luna High

- Status: Accepted
- Date: 2026-08-18
- Owners: Core, Safety
- Builds on: ADR 0016 and ADR 0046

## Context

Provider-level routing does not guarantee a cheap model: the current Claude catalog orders enabled Opus and Sonnet entries before Haiku. The Codex executor also selects a model without controlling reasoning effort. The first product path instead requires predictable Haiku and Luna High usage, bounded calls, and no silent premium escalation.

## Decision

The Economy Profile uses exact, audited model pins with no premium fallback. Haiku produces the Task Graph, Schema Plan, browser plans, and one independent Release Assessment. Luna runs with high reasoning effort for implementation and quality repairs. Deterministic checks, builds, and Playwright execution make no model call.

Opus, Sonnet, Terra, Sol, and any other model are ineligible while the Economy Profile is active. A provider or executor failure permits one Technical Retry with the same exact model after restoring its checkpoint; a second failure pauses execution for operator direction.

Environment Preflight runs before any Task Agent call. Missing tools, unauthenticated sessions, stopped Docker, unhealthy Supabase, occupied ports, and external-service availability failures pause with an actionable diagnostic. They consume neither implementation nor repair calls. The same rule applies when deterministic verification classifies a failure as infrastructure rather than generated-application quality.

Task execution is sequential by default. A maximum of two independent tasks may run concurrently only after Issue Radar Lite passes both its Local and Cloudflare Targets. Each task receives one Luna implementation call and at most two Luna quality-repair calls. Exhaustion preserves the failed work on its draft branch and requests operator direction.

There is no LLM review after every Vertical Task. Per-task deterministic and browser gates remain blocking, and Haiku performs one independent Release Assessment after the graph is complete. That report is advisory: it informs the operator's Local Acceptance but cannot accept, reject, block, or automatically trigger a repair. Spend control is a Call Budget, not a dollar estimate; token and estimated-cost values remain telemetry rather than authorization.

After a human Local Acceptance rejection, the run makes no automatic call. The operator may authorize one Final Repair Pass limited to one Luna High call over the rejected criteria and one replacement Haiku Release Assessment. The prior assessment remains historical but becomes stale. A second rejection, a failed final repair, or exhaustion of either call ends the run as a Preserved Draft; new requirements require a new PRD Revision instead.

## Consequences

The `web-app-v1` workflow and model catalog must stop relying on provider ordering, and every Luna invocation must pass high reasoning effort explicitly. Existing emergency ceilings remain fail-safe containment, but they cannot extend the smaller Economy Profile Call Budget. A Final Repair Pass adds at most two explicitly approved provider calls to a rejected run. Infrastructure classification becomes cost-authoritative and therefore must come from deterministic evidence rather than Task Agent prose. Premium models can be introduced later only through a different operator-selected profile.
