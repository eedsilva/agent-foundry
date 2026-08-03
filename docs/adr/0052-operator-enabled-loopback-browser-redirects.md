# ADR 0052: Operator-enabled loopback browser redirects

- Status: Accepted
- Date: 2026-08-03
- Owners: Core, Platform
- Amends ADR 0017 (preview network proxy) and ADR 0020 (declarative browser verification)

## Context

The preview proxy and declarative browser verifier intentionally keep generated
applications inside the tokenized preview origin. That deny-by-default boundary
is the right normal behavior, but it prevents an operator from validating a
generated app whose authentication flow redirects through its own local
Supabase service. Issue #381 exposed this as a separate blocker from the
reported generated-app `__name` error.

The exception must remain an operator-validation tool. It must not turn the
preview into an arbitrary local-network proxy, and it must not weaken normal
browser verification or become a default deployment profile.

## Decision

The runtime exposes `ALLOW_LOCAL_BROWSER_REDIRECTS`, defaulting to `false`.
When an operator explicitly enables it:

- the preview proxy preserves absolute HTTP(S) `Location` values only when
  their host is loopback; external redirects continue to be rewritten to the
  session root;
- the browser verifier learns a loopback origin only from a redirect emitted by
  the preview or by an already learned loopback origin;
- the learned authority is added to the network-policy private exceptions so
  the redirected request can reach the local service; and
- arbitrary local resources, direct local requests, non-HTTP(S) URLs, and
  external origins remain blocked.

The setting is process configuration, not a project or policy default. It is
for a trusted local operator running a bounded validation slice and must be
disabled for normal development, CI, and any remotely exposed deployment.

## Alternatives considered

- **Allow every loopback origin in browser verification.** Rejected because a
  generated page could then probe unrelated local services without first
  taking an explicit redirect path.
- **Add the per-project Supabase origin to `browserAllowedOrigins`.** Rejected
  because the port is allocated dynamically and the policy is intentionally an
  exact-origin contract.
- **Remove the browser network boundary.** Rejected because it would erase the
  SSRF and cross-project protections established by ADR 0020.
- **Make the exception the default.** Rejected because the override exists only
  to unblock operator diagnosis of a real-mode validation run.

## Consequences

Normal runs and existing policies are unchanged. The opt-in run has a broader
loopback reachability boundary, so the operator must treat the generated app,
preview logs, and browser evidence as sensitive local data. There is no data,
schema, or artifact migration: `false` preserves the previous behavior and
existing persisted records remain valid.

The exception does not fix a generated application's root cause. A successful
operator run must still retain the browser error stack, identify the generated
source/chunk, and repair that app before the validation issue can close.

## Validation and rollback

Configuration tests cover the false default and explicit opt-in. Preview-proxy
tests cover preserving a loopback redirect while rewriting external redirects.
Browser-verifier tests cover following an explicitly enabled loopback redirect
and blocking an arbitrary local resource. The remaining acceptance is a real
operator `/sign-in` slice with a healthy per-project Supabase stack, followed by
the TODO happy-path run only after that slice is clean.

Rollback is a normal code revert of the runtime/config, proxy, verifier, and
documentation changes. No migration or data cleanup is required; with the
implementation reverted, the existing deny-by-default redirect behavior is
restored.
