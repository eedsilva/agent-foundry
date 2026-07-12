# Product Contract

## Personal Builder v1

**Primary user:** a software engineer who wants to turn requirements into auditable repository changes without delegating the repository blindly to one model.

**Primary job:** receive a PRD or change request and produce an executable, reviewable, explainable, and publishable change.

**Promise:**

```text
prompt / PRD / existing repository
→ plan
→ implementation
→ deterministic and browser verification
→ preview
→ iterative feedback
→ diff and GitHub change
→ publish with rollback
```

**Differentiation:** provider-independent execution, persistent artifacts, recovery, model-routing evidence, deterministic gates, and human control.

**North-star metric:** percentage of change requests accepted without manual code edits.

Supporting metrics include time to accepted change, human intervention minutes, first-pass success, repair loops, rollback rate, unrecovered failures, quota consumption, and regressions after merge.

**Non-goals for Personal v1:** multi-tenancy, billing, real-time collaboration, marketplace, Kubernetes, fine-tuning, a proprietary model, and an internally hosted replacement for every managed backend.

## Hosted Platform v2

Hosted v2 turns the proven builder into a multi-user service. It adds distributed control and execution planes, tenant isolation, organizations, RBAC, quotas, collaboration, billing, abuse controls, SLOs, and incident operations.

Hosted v2 does not block Personal v1 unless a concrete dependency is represented in the roadmap graph.

## Product test

A capability belongs on the Personal v1 critical path only when its absence prevents a trusted developer from going from request to accepted, verified, and published change. Clever routing, extra agents, or distributed infrastructure do not pass that test by themselves.
