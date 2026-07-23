# ADR 0028: Deny-by-default network policy

- Status: Accepted
- Date: 2026-07-22
- Owners: Safety and Executors

## Context

ADR 0025's Docker backend mapped an allowlist to Docker's ordinary `bridge` network. That exposed a
default route and did not enforce `allowedHosts`; clearing proxy environment variables, opening a raw
socket, using a literal private address, or rebinding DNS could bypass policy. Preview dependency
installation still executed on the host, and Chromium's origin checks did not pin the IP they had
validated.

Issue #48 requires no egress by default, observable DNS and HTTP policy, explicit allowlisting,
blocking of metadata/private/loopback destinations, a separate dependency-install mode, and browser
access limited to the preview plus authorized public origins.

## Decision

`ExecutionNetworkPolicy` is a fail-closed discriminated contract. `none` permits no hosts;
`allowlist` requires normalized exact DNS hostnames. Schemes, paths, ports, wildcards, trailing dots,
IP literals, localhost, malformed labels, and duplicates are rejected. A `purpose` identifies
`execution`, `dependency-install`, or `browser` decisions.

For an allowlisted Docker sandbox, `DockerSandboxRunner` creates a random per-sandbox
`docker network create --internal` network. The sandbox joins only that network. A hardened Node
sidecar joins both the internal network and Docker's ordinary bridge and is the only egress path:

```text
sandbox -> internal Docker network -> DNS + HTTP/CONNECT policy sidecar -> bridge -> public host
```

The sidecar drops all Linux capabilities, then adds only `NET_BIND_SERVICE` so its unprivileged UID
can bind the sandbox DNS port 53. It remains read-only, non-root, PID/memory/CPU limited, and protected
by `no-new-privileges`.

The sandbox receives the sidecar's inspected internal IP as its DNS server and HTTP(S) proxy. This is
convenience, not the security boundary: the internal network prevents raw public, metadata, host, or
private traffic even if a process clears those variables. Partial creation and repeated destruction
remove the sandbox, sidecar, and network. Sandboxes and sidecars use Docker auto-removal and a bounded
TTL. Networks carry policy and expiration labels; a best-effort sweep on later creates removes expired
orphan networks while deferring any network that still has active endpoints.

The sidecar resolves every new DNS, HTTP, and CONNECT decision. It rejects the complete answer set if
any address is loopback, link-local/metadata, private, CGNAT, multicast, documentation/benchmark,
reserved, IPv4-mapped IPv6, ULA, or IPv6 link-local/multicast. It then connects to the already
validated literal IP, never the hostname, eliminating the validation/connect DNS race. Results are
not cached across connections, so a later private rebinding answer is denied. HTTP uses port 80 and
CONNECT uses 443 unless the browser supplied an exact authorized origin authority. HTTPS paths remain
encrypted; the observable decision is hostname and port, not intercepted TLS.

Real-mode preview dependency installation uses `DockerPreviewInstaller` with purpose
`dependency-install`, an explicit registry allowlist, and a controlled `/project` workspace mount.
It never falls back to a host install when Docker or policy startup fails. Its bounded policy events
are stored on the preview command plan.

`PlaywrightBrowserVerifier` launches Chromium behind the same resolve-and-pin proxy while retaining
its exact-origin, preview-prefix, redirect, and WebSocket checks. Only the system-supplied preview
host and port receive a private-address exception; user policy cannot grant loopback or IP-literal
origins. Browser decisions are stored as a JSON evidence artifact. Selection screenshot capture uses
the same exact preview exception.

Audit events contain only timestamp, purpose, protocol, decision, hostname, port, resolved addresses,
and reason. They exclude paths, queries, headers, cookies, authorization, and bodies. Sidecar logs,
browser capture, contract parsing, and persisted evidence all enforce the same 1,000-event upper bound.

## Migration

Existing `none` policies keep their behavior and default to purpose `execution` when parsed. Typed
call sites state the purpose explicitly. User-configured browser origins that are IP literals or
localhost now fail validation. Real-mode preview installation now requires Docker and the pinned Node
image; mock mode retains its deterministic local fixture path.

`LocalExecutionPlane` remains the active agent execution plane until the separately tracked secret
broker exists. This ADR makes `DockerSandboxRunner` safe to receive allowlisted work and moves real
dependency installation/browser verification behind the policy; it does not claim host credential
isolation for the still-local agent CLI.

## Validation and rollback

Pure and proxy tests cover SSRF ranges, mixed DNS answers, direct IPs, host mismatch, event redaction,
and public-to-private rebinding. Real-browser tests prove the exact preview exception and zero requests
to a separately authorized private origin. Real-Docker CI proves raw socket denial, allowed/forbidden
DNS, allowlisted HTTP, metadata denial, audit events, and cleanup.

Rollback is a revert of this ADR's PR. Do not replace the internal network with `bridge` as a partial
rollback; if policy initialization fails, the correct operational state is failed/deny, not open
egress. Reverting restores the prior documented insecure behavior and therefore must not be used for
untrusted execution.
