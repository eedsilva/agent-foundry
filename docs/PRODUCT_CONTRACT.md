# Product Contract

## Personal Builder v1

**Primary user:** one trusted solo developer using macOS who wants a private, self-owned alternative to Lovable.

**Primary job:** turn a short idea into a greenfield, authenticated, full-stack web application; evolve it conversationally and visually; verify every change; and publish it to an existing self-managed VPS.

**Promise:**

```text
idea / prompt / optional reference image
-> clarification
-> full multi-agent plan, architecture, build, review, repair and verification
-> local Next.js + Supabase application
-> conversational and visual iteration
-> immutable local Git version
-> isolated Docker Compose deployment on the owner's VPS
-> health check, backup and application rollback
```

**Differentiation:** provider-independent execution, a rigorous multi-agent pipeline for every build, persistent artifacts, adaptive model routing, deterministic and browser gates, reversible local Git history, self-hosted full-stack infrastructure, and explicit human authority over risky actions.

**North-star metric:** percentage of new-app requests and follow-up operations that reach a working, verified result without manual code edits.

Supporting metrics include time to accepted version, human intervention minutes, first-pass success, repair cycles, draft-branch rate, application rollback rate, unrecovered failures, provider usage, and regressions discovered after promotion.

### V1 finish line

V1 ships only when the Issue Radar golden application proves, end to end:

- chat-first creation from a short idea;
- the full planner/reviewer/architect/developer/reviewer/verifier/release pipeline;
- evidence-based model routing across Codex, Claude and AGY (the existing router; learned adaptive routing remains exploratory v0.9);
- a generated Next.js, TypeScript, Tailwind CSS and shadcn/ui repository;
- an isolated local Supabase Docker stack;
- default email/password authentication, protected routes, sessions and baseline RLS;
- CRUD, filters, metrics and attachment storage;
- local preview plus deterministic and browser verification;
- reference-image context;
- element-aware prompting and direct visual controls;
- one verified local Git commit per successful operation;
- failed-work preservation on a draft branch;
- isolated deployment to an existing Ubuntu LTS VPS using Docker Compose;
- immediate host/port access and optional manually configured custom domain with automatic TLS;
- scheduled backups retained on the VPS and copied to the local Mac; and
- application-code/configuration rollback without automatic database reversal.

Full-stack provisioning and VPS publishing are Personal v1 launch blockers. They are not post-v1 enhancements.

### Operating and trust boundary

- Agent Foundry runs on macOS, binds to loopback, and serves one trusted operator.
- The operator supplies locally authenticated agent CLIs, an existing VPS, SSH access and `.env` files.
- Generated applications may be public. The Agent Foundry control plane may not be exposed as a public service in v1.
- Normal changes run autonomously. Destructive migrations, production deployment, production secret changes and other difficult-to-reverse operations require approval.
- There is no normal execution budget. An emergency ceiling stops a run after four hours or ten consecutive repair cycles without approval.

### Opinionated generated-app platform

V1 supports one golden stack: Next.js, TypeScript, Tailwind CSS, shadcn/ui and one isolated Supabase Docker stack per application. Authentication is always present and uses email/password only. V1 does not promise SMTP or self-service password reset; an administrator performs resets manually.

Credentials and secrets use local `.env` files. They must be ignored by Git and excluded from prompts, artifacts, screenshots and logs. This is a trusted-local convenience, not strong secret isolation.

### Source ownership and GitHub

Every generated project is an ordinary local Git repository and can be opened in the user's desktop editor. Local Git is the source of truth and works offline. GitHub is optional and adds remote backup, pull, push, branches and pull requests; GitHub availability must not block local builds, versions or rollback.

### Explicit Personal v1 non-goals

- Existing-repository import or arbitrary-framework support.
- Vercel, Supabase Cloud or cloud-provider VPS provisioning.
- Multi-tenancy, billing, credits, real-time collaboration or public Agent Foundry hosting.
- OAuth, magic links, SMTP or self-service password reset.
- A built-in browser code editor.
- Image generation or editing.
- Automatic DNS-provider mutation.
- Automatic database rollback.
- More than one generated-app stack.

### Post-v1 personal evolution

- The next personal release adds Linux control-plane support, a built-in browser code editor and existing-repository workflows.
- A later personal release adds Windows control-plane support.

## Hosted Platform v2

Hosted Platform v2 is a separate product track. It turns the proven builder into a multi-user service with distributed control and execution planes, tenant isolation, organizations, RBAC, quotas, collaboration, billing, abuse controls, SLOs and incident operations.

Hosted Platform v2 does not block Personal Builder v1 unless a concrete dependency is represented in the roadmap graph.

## Product test

A capability belongs on the Personal v1 critical path when its absence prevents the trusted owner from completing the Issue Radar golden journey. Infrastructure, agent count or routing sophistication do not pass that test unless they protect or enable an observable part of that journey.
