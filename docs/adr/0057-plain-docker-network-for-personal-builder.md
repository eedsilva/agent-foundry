# ADR 0057: Plain Docker network for the personal builder

- Status: Accepted
- Date: 2026-08-07
- Owners: Core, Executors
- Supersedes ADR 0017 and ADR 0028; resolves issue #440

## Context

ADRs 0017 and 0028 built a deny-by-default network stack for sandboxes: a fail-closed
`ExecutionNetworkPolicy` contract, a per-sandbox internal Docker network with a hardened
dual-homed sidecar as the only egress path (DNS + HTTP proxy with allowlisting and audit
events), a matching in-process proxy in front of verification Chromium, and network-evidence
artifacts plumbed through the preview and browser-verification contracts.

That design assumed untrusted third-party code on a hosted platform. Agent Foundry is now a
personal builder: the sandboxed code is generated for — and reviewed by — the machine's owner,
who already runs the provider CLIs unsandboxed on the same host with full network access. The
stack cost ~1,255 lines plus contract, runner, orchestrator, and CI wiring, and its evidence
artifacts had no consumers.

## Decision

Sandboxes get ordinary Docker networking; the policy stack is deleted.

- **Sandboxes** (`DockerSandboxRunner`) run on Docker's default bridge for every mode —
  execution, dependency install, preview. No `--internal` networks, no sidecar, no proxy
  environment, no DNS interception. The other hardening flags (read-only rootfs, cap-drop,
  pids/memory/cpu limits, digest-pinned images, mount validation) are unchanged.
- **Contracts**: `ExecutionNetworkPolicy`, `NetworkPolicyEvent`, and the `network`/
  `networkPolicy` fields on `SandboxSpec` and `ExecutionRequest` are removed. These were only
  ever in-flight values, never persisted, so no stored data breaks.
- **Network evidence** is gone: `installNetworkEvents`, the `browser-network-policy-*`
  artifact, and `BrowserVerificationEvidence.networkEvents`. Nothing consumed them; the
  Playwright trace remains the debugging record for verify-time network traffic.
- **Browser verification keeps origin confinement — deliberately.** The in-process proxy in
  front of Chromium is deleted, but the existing `context.route()`/`routeWebSocket()`
  `permitted()` checks stay: verification Chromium may only reach the preview prefix and the
  release policy's `allowedOrigins` (plus the operator-only local-redirect escape hatch). This
  is not a security control against the sandbox — it keeps verification deterministic (an
  unreachable font CDN cannot fail a run) and stops an agent-driven browser from wandering the
  LAN. Do not "finish the cleanup" by removing it.

## Consequences

- Sandboxed installs and generated apps have full egress from the owner's machine — the same
  trust level as the provider CLIs that generate the code. Reinstating egress policy for a
  future hosted/multi-tenant deployment means rebuilding it (start from ADR 0028's design).
- The CI sidecar build step and `build:sidecar` script are gone; `@agent-foundry/executors`
  builds with tsup only.
- `browserAllowedOrigins` validation no longer rejects IP-literal or single-label hostnames
  (the strict DNS-hostname schema died with the proxy); an origin is any exact `http(s)`
  origin.
