# ADR 0059: App-shape contract in the plan artifact

- Status: Proposed
- Date: 2026-08-08
- Owners: Core
- Tracked by epic #470 (build tickets #478, #479)

## Context

Every generated app is planned as a monolithic pass. Different app shapes (CRUD-heavy,
dashboard-heavy, auth-heavy) share modules — auth, CRUD resources, dashboards, storage —
but nothing in the plan names them, so nothing is reused across runs and quality does not
compound. The product contract fixes one golden stack; modularity must vary the *shape*
within that stack, not the stack.

Alternatives considered: a curated scaffold-template library per app shape (faster visible
wins, rots quickly, planner bypasses it), or building contract and templates simultaneously
(widest scope, slowest first evidence).

## Decision

The plan artifact declares an app-shape contract: a validated list of composable modules
(e.g. `auth`, `crud:<resource>`, `dashboard`, `storage`) with per-module acceptance
channels. The planner emits it; task-graph generation consumes it, producing per-module
tasks that reference proven patterns. Scaffold templates come later, derived from modules
that recur in real runs — templates are an optimisation of the contract, not a parallel
mechanism.

## Consequences

- Plan artifact contract version bumps; validators and operator approval UI must render
  modules.
- Tracer evidence per app shape maps cleanly onto modules, making defect lists actionable.
- Template work is deferred until module recurrence is observed.
