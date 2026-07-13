# Personal Builder v1 Design

## Product outcome

Agent Foundry Personal Builder v1 is a private, macOS-hosted alternative to Lovable for one trusted operator. It turns a short conversational idea into a greenfield, authenticated, full-stack web application, verifies every change through a rigorous multi-agent pipeline, runs the application locally, and publishes it to an existing self-managed VPS.

The release is complete only when the Issue Radar golden application passes this journey:

```text
idea -> clarification -> plan -> architecture -> implementation -> review/repair
     -> deterministic verification -> browser verification -> local preview
     -> conversational and visual iteration -> immutable Git version
     -> isolated VPS deployment -> health check -> application rollback
```

## Primary user and operating boundary

- One technically capable owner operates Agent Foundry.
- The control plane runs on macOS and binds to loopback.
- Agent execution uses locally authenticated Codex, Claude, and AGY CLIs.
- Generated applications may be public, but Agent Foundry itself is not a hosted or multi-tenant service.
- V1 creates greenfield projects only. Existing repository import is post-v1.
- Local Git is mandatory and authoritative. GitHub is optional.

## Generated application contract

Every v1 project uses one opinionated golden stack:

- Next.js;
- TypeScript;
- Tailwind CSS;
- shadcn/ui;
- shared design tokens;
- an isolated Supabase Docker stack per project;
- email/password authentication enabled by default;
- signup, login, logout, protected routes, sessions, and baseline RLS;
- manual administrator password reset, with no SMTP or self-service reset promise;
- local `.env` files for credentials and application secrets;
- ordinary source files in a local Git repository.

Reference images may be attached as design or debugging context. Image generation and editing are outside v1.

## Builder experience

The entry point is chat, not a required PRD. Agent Foundry asks only questions that materially affect the result, generates a versioned plan, and then runs the complete pipeline for every build:

1. planner;
2. plan reviewer;
3. architect;
4. architecture reviewer;
5. developer;
6. code reviewer;
7. deterministic verifier;
8. browser verifier;
9. repair agents when a gate fails;
10. final release assessment.

The model router selects Codex, Claude, or AGY independently for each role using constraints, priors, observed reliability, quota pressure, and quality outcomes. Mutable fallbacks start from clean Git checkpoints.

Normal code and UI changes proceed without approval. Explicit approval is required for destructive database migrations, production deployment, production secret changes, and other difficult-to-reverse operations.

Visual editing includes both:

- selecting a preview element and describing the desired change; and
- direct controls for text, color, spacing, typography, layout, and shared design tokens.

Both paths produce normal source-code patches and pass through the same review and verification gates.

## Versions, failures, and execution ceilings

- Each successful chat operation creates one immutable project version and one Git commit.
- Internal attempts and repairs are audit artifacts, not primary-history commits.
- A failed operation never replaces the last verified version.
- Failed work is preserved on an isolated draft branch for inspection, retry, or deletion.
- There is no normal user-configured time, token, or attempt budget.
- An emergency ceiling stops a pathological operation after four hours or ten consecutive repair cycles without approval.
- Manual cancellation is always available.

## Local runtime

Each generated project owns an isolated Docker Compose environment containing its Supabase services and application dependencies. Local lifecycle operations include initialize, start, stop, inspect, migrate, seed, reset with confirmation, health check, and cleanup.

Generated code, dependency installation, tests, and preview execute through the safe runtime boundary. Local `.env` files are excluded from Git, prompts, artifacts, screenshots, and logs. This is convenience for a trusted operator, not strong secret isolation.

## VPS publishing

V1 deploys to an existing VPS supplied over SSH. It does not provision cloud infrastructure.

- Ubuntu LTS is the tested golden host.
- Debian-based hosts are best-effort compatible.
- Docker Compose runs one isolated application and Supabase stack per project.
- Caddy provides reverse proxying and automatic TLS.
- Every deployment receives an immediate host/port address.
- A custom domain is optional; the user creates DNS records manually.
- Agent Foundry validates DNS and configures Caddy after the record resolves.
- Production application rollback restores application code and container configuration only.
- Database migrations are forward-moving and are never automatically reversed.
- Destructive migrations require approval.
- Scheduled database and storage backups are retained on the VPS and copied to the local Mac.
- Restore is a separate, explicit, human-approved operation.

## Source ownership and integrations

The generated repository is always available on disk and can be opened in the user's local editor. A built-in browser code editor is post-v1. GitHub connection is optional and adds remote backup, pull, push, branches, and pull requests without becoming the source of truth or blocking offline work.

## Issue Radar release proof

Issue Radar is the single canonical v1 application. Its release suite must prove:

- default authentication and protected application shell;
- issue CRUD, filters, dashboard metrics, and persisted data;
- attachment storage and RLS authorization;
- chat-first creation and follow-up change requests;
- reference-image attachment;
- element-aware prompts and direct visual controls;
- deterministic and browser verification, including a repair loop;
- one verified Git commit per successful operation;
- failure preservation on a draft branch;
- local Docker/Supabase lifecycle;
- deployment to Ubuntu LTS over SSH;
- host/port access and optional custom domain with TLS;
- scheduled VPS backup plus local-Mac copy;
- application-only rollback without database reversal.

## Explicit non-goals

- Existing repository import.
- Vercel, Supabase Cloud, or cloud VPS provisioning.
- Multi-tenancy, billing, credits, real-time collaboration, or public Agent Foundry hosting.
- OAuth, magic links, SMTP, or self-service password reset.
- Built-in browser code editor.
- Image generation or image editing.
- Automatic DNS-provider changes.
- Automatic database rollback.
- Multiple generated-app stacks or arbitrary framework support.

## Post-v1 sequence

- The next personal release adds Linux control-plane support, a built-in browser code editor, and existing-repository workflows.
- A later personal release adds Windows control-plane support.
- Hosted Platform v2 remains a separate product track for multi-user SaaS operation.

## Confidence model

The roadmap may claim at least 95% planning coverage only when every normative requirement above maps to:

1. a milestone exit criterion;
2. one or more implementation issues;
3. observable acceptance criteria;
4. named automated or manual evidence; and
5. a golden-journey assertion or an explicit non-goal.

This is traceability confidence, not a guarantee that future implementation will succeed. Release confidence comes from executing the Issue Radar suite and closing all critical/high findings.
