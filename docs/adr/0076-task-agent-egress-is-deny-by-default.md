# ADR 0076: Task Agent egress is deny-by-default

- Status: Accepted
- Date: 2026-08-18
- Owners: Core, Executors, Safety
- Supersedes: ADR 0057 for Task Agent execution and dependency installation
- Preserves: ADR 0057's browser origin confinement and its rejection of network evidence as an acceptance artifact

## Context

ADR 0057 removed the earlier network proxy because Agent Foundry was a trusted personal builder and the policy cost exceeded its observed value. Task Agents and dependency installation now receive ordinary Docker or host network access, while the current Local Execution Plane launches provider CLIs directly on the host.

The Personal Builder v1 contract now requires each Task Agent to reach only its model provider, approved package registries, official documentation, and required local services. That restriction cannot be honestly implemented by passing an allowlist field to the current host process: the execution backend must enforce egress independently of the model and generated commands.

## Decision

Every mutating or planning Task Agent runs behind a Task Network Policy with deny-by-default egress. Its per-role allowlist contains only:

- the selected model provider's authentication and inference endpoints;
- the public `registry.npmjs.org` package registry needed by the generated stack;
- exact official documentation origins pinned by the scaffold and explicitly enabled for the task; and
- exact loopback or project-network services required for preview and Local Supabase.

Private networks, cloud metadata endpoints, arbitrary public destinations, and undeclared local ports remain blocked. Dependency installation uses the same enforced policy. Browser verification retains its existing exact-origin confinement.

The execution filesystem exposes only the assigned worktree, an ephemeral temporary directory, and scoped provider-authentication capabilities. It does not expose the operator's home directory, Foundry Data Directory, other projects, SSH material, full keychain, Docker socket, or host credential files. Task Agents cannot use `sudo`, privileged containers, or host-level package installation.

V1 accepts public registry packages resolved by the pinned pnpm lockfile only. Private registries, Git dependencies, GitHub release assets, external tarballs, local path dependencies outside the repository, and alternate package mirrors are unsupported and fail before installation. Registry redirects outside the approved origin remain blocked.

The current host-launched Local Execution Plane does not satisfy this decision. Implementation must restore an enforcing boundary based on ADR 0028's internal-network plus audited DNS/HTTP proxy design, or another backend that passes equivalent escape tests. Provider CLI authentication must be exposed as a scoped capability without mounting unrelated host credentials. An allowlist stored only in a request or prompt is not enforcement.

Network-policy denials are deterministic infrastructure or policy failures. They do not consume a Luna implementation or repair call unless the generated application itself requested an undeclared destination contrary to its approved contract. Raw network traffic and browsing content are not persisted; bounded denial diagnostics may enter the Diagnostic Bundle after redaction.

## Alternatives considered

- **Keep ordinary networking because the operator trusts generated code.** Rejected because it contradicts the accepted egress boundary and exposes unrelated local and internet resources.
- **Ask agents to obey an allowlist in their prompt.** Rejected because generated commands and dependencies can bypass instructions.
- **Apply policy only to preview.** Rejected because generation and package installation execute code before preview begins.

## Consequences

ADR 0057's simpler network path is no longer sufficient for Task Agents. Reintroducing enforcement adds a proxy/sidecar or equivalent runner, provider-auth capability plumbing, domain maintenance, denial diagnostics, and escape regression tests. This is intentional security complexity; until it exists, Economy Profile real execution is not compliant with the new v1 contract.

The allowlist can break legitimate package or documentation access. It permits no broad wildcard, arbitrary Git host, search engine, blog, forum, or general web access. Adding one exact official origin requires operator approval and a new policy revision scoped to the current project and PRD Revision. The origin may be reused by later calls in that run but never becomes a global permission automatically. Failures must name the blocked hostname and role, pause without spending a repair call, and require that approved policy change rather than silently broadening egress.

## Validation and rollback

Acceptance requires real escape tests for direct IP, alternate DNS, redirects, WebSocket, raw sockets, private ranges, metadata addresses, undeclared loopback ports, package lifecycle scripts, mount traversal, home-directory reads, Docker socket access, SSH/keychain access, privilege escalation, and sibling-project reads, plus positive tests for each approved provider, registry, documentation origin, project-local service, and worktree mutation. Cancellation and cleanup must remove every policy sidecar, internal network, temporary directory, and scoped authentication capability.

Rollback requires superseding this ADR with a different enforceable boundary. Returning to ordinary networking would make the documented v1 security contract false.
