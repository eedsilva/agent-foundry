# Issue 48 Deny-by-default Network Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sandbox, dependency-install, and browser egress deny-by-default, allowing only explicit DNS hostnames through an observable policy proxy while blocking metadata, loopback, private ranges, direct-IP bypasses, and DNS rebinding.

**Architecture:** An allowlisted sandbox is attached only to a per-sandbox Docker `--internal` network. A hardened, dual-homed Node sidecar is the only member that also joins Docker's external bridge; it serves DNS and HTTP/CONNECT, resolves each connection itself, rejects any non-global answer, and connects to the already-validated IP. The sandbox therefore cannot bypass policy by clearing proxy variables. The same resolver/pinning core backs a host-local Chromium proxy. Dependency installs use the Docker runner with `purpose: 'dependency-install'`, a controlled workspace mount, and an independently recorded event stream.

**Tech Stack:** TypeScript, Zod, Node HTTP/net/dns/dgram, Docker CLI through `execa`, Playwright, Vitest, npm workspaces.

## Global Constraints

- Work only in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-48-network-policy` on `agent/issue-48-network-policy`; never push implementation directly to `main`.
- Follow TDD for every behavior: add the smallest public regression, observe the expected RED failure, implement minimally, then observe GREEN.
- `mode: 'none'` means no network namespace attachment and no allowed hosts; `mode: 'allowlist'` requires at least one exact DNS hostname.
- Reject schemes, paths, userinfo, ports, wildcards, trailing-dot ambiguity, IP literals, `localhost`, malformed labels, and duplicate/case-variant hosts at the contract boundary.
- For every DNS/HTTP/CONNECT attempt, reject the whole resolution if any answer is loopback, metadata/link-local, RFC1918, CGNAT, multicast, documentation/benchmark/reserved, IPv4-mapped IPv6, ULA, or IPv6 link-local/multicast.
- Connect to the validated literal address; never resolve the hostname a second time. Re-resolve every new connection and never cache a prior public answer across requests.
- Sandbox containers never join the default bridge in allowlist mode. The proxy sidecar is the only dual-homed container, and every partial-create/destroy path removes the sandbox, sidecar, and network.
- Audit events contain timestamp, purpose, protocol, decision, hostname, port, addresses, and reason only. Never persist URL path/query, headers, credentials, or response bodies.
- HTTP is restricted to port 80 and CONNECT to 443. HTTPS observability is hostname/port/decision only; TLS interception is out of scope.
- The browser may reach its exact system-supplied preview origin even when it is loopback/private. User-supplied allowed origins never receive that exception.
- Dependency installation runs under a distinct `dependency-install` purpose and emits durable, redacted policy events; it must not silently fall back to a host install.
- Docker integration tests remain `describe.skipIf(!hasDocker)` locally and execute for real in GitHub Actions.

---

### Task 1: Make the network-policy contract fail closed

**Files:**

- Modify: `packages/contracts/src/execution-plane.ts`
- Modify: `packages/contracts/src/execution-plane.test.ts`
- Modify: `packages/contracts/src/policy.ts`
- Modify: `packages/contracts/src/policy.test.ts`

**Interfaces:**

```ts
export const NetworkPolicyPurposeSchema = z.enum(['execution', 'dependency-install', 'browser']);
export const ExecutionNetworkPolicySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('none'),
      allowedHosts: z.tuple([]),
      purpose: NetworkPolicyPurposeSchema.default('execution'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('allowlist'),
      allowedHosts: z.array(NetworkPolicyHostnameSchema).min(1),
      purpose: NetworkPolicyPurposeSchema.default('execution'),
    })
    .strict(),
]);
export const NetworkPolicyEventSchema = z
  .object({
    timestamp: z.string().datetime(),
    purpose: NetworkPolicyPurposeSchema,
    protocol: z.enum(['dns', 'http', 'connect']),
    decision: z.enum(['allow', 'deny']),
    hostname: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    addresses: z.array(z.string()),
    reason: z.string().min(1),
  })
  .strict();
```

- [ ] Add table-driven contract tests that accept `registry.npmjs.org` and default `purpose` to `execution`, accept an explicit `dependency-install`, and reject empty allowlists, hosts with schemes/paths/ports/wildcards/trailing dots, IP literals, localhost, and `none` with hosts.
- [ ] Run `npx vitest run packages/contracts/src/execution-plane.test.ts packages/contracts/src/policy.test.ts` and verify RED on the new invalid-host and purpose assertions.
- [ ] Add one shared `NetworkPolicyHostnameSchema`, the discriminated policy union, and the bounded audit-event schema. Reuse the hostname schema to make `ProjectPolicySchema.browserAllowedOrigins` reject user-configured private/IP-literal origins.
- [ ] Update existing fixtures to rely on the default `purpose` where possible; do not mechanically add it to every literal.
- [ ] Rerun the focused contract tests and `npm run typecheck --workspace @agent-foundry/contracts`; expect GREEN.

---

### Task 2: Build the resolve-validate-pin policy core and proxy

**Files:**

- Create: `packages/executors/src/network-policy.ts`
- Create: `packages/executors/src/network-policy.test.ts`
- Create: `packages/executors/src/network-policy-proxy.ts`
- Create: `packages/executors/src/network-policy-proxy.test.ts`
- Create: `packages/executors/src/docker-network-policy-sidecar.ts`
- Modify: `packages/executors/src/index.ts`
- Modify: `packages/executors/package.json`

**Interfaces:**

```ts
export interface NetworkPolicyResolver {
  lookup(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>>;
}
export interface NetworkPolicyConnector {
  connect(input: { address: string; port: number; servername: string }): Socket;
}
export async function resolveAllowedDestination(input: {
  hostname: string;
  port: number;
  allowedHosts: ReadonlySet<string>;
  resolver: NetworkPolicyResolver;
}): Promise<{ hostname: string; port: number; addresses: string[]; selectedAddress: string }>;
export async function createNetworkPolicyProxy(options: {
  policy: ExecutionNetworkPolicy;
  privateExceptions?: ReadonlySet<string>;
  onEvent(event: NetworkPolicyEvent): void;
}): Promise<{ url: string; close(): Promise<void> }>;
```

- [ ] Write classifier tests for every blocked IPv4/IPv6 class, including `169.254.169.254`, `100.64.0.0/10`, `0.0.0.0`, documentation ranges, ULA, link-local, multicast, and IPv4-mapped IPv6. Add a fake resolver that returns public then private and assert the second request is denied. Assert the connector receives the selected IP, never the hostname.
- [ ] Write HTTP/CONNECT proxy tests for exact host allowlisting, allowed ports, direct-IP/userinfo rejection, mixed public/private answers, one bounded event per decision, and absence of path/query/header data from the serialized event.
- [ ] Run `npx vitest run packages/executors/src/network-policy.test.ts packages/executors/src/network-policy-proxy.test.ts`; verify RED because the modules do not exist.
- [ ] Implement `isPublicAddress` with `node:net` plus explicit CIDR byte checks, normalize DNS names once, reject the entire answer set on any non-public result, and pass the selected literal address to the connector.
- [ ] Implement a Node-stdlib HTTP absolute-form and CONNECT proxy. Do not follow redirects. Build the sidecar as a second `tsup` entry (`dist/docker-network-policy-sidecar.js`) so Docker runs exactly the tested core rather than a duplicated string implementation.
- [ ] Rerun the focused suites and executors typecheck; expect GREEN.

---

### Task 3: Enforce the policy in `DockerSandboxRunner`

**Files:**

- Modify: `packages/executors/src/docker-sandbox-runner.ts`
- Modify: `packages/executors/src/docker-sandbox-runner.test.ts`
- Modify: `packages/executors/src/docker-sandbox-runner.integration.test.ts`
- Modify: `packages/domain/src/sandbox-runner.ts`
- Modify: `packages/contracts/src/sandbox.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

```ts
export interface SandboxExecRequest extends SandboxExec {
  onOutput?: (chunk: SandboxOutputChunk) => void;
}
export interface SandboxNetworkEvidence {
  events: NetworkPolicyEvent[];
}
export class DockerSandboxRunner implements SandboxRunner {
  async networkEvidence(sandbox: SandboxHandle): Promise<SandboxNetworkEvidence>;
}
```

- [ ] Replace the existing unit expectation `allowlist -> bridge` with RED tests proving sandbox create args never contain `--network=bridge`, the sidecar alone is dual-homed, proxy/DNS environment uses the inspected internal IP, and failures at network/sidecar/connect/start stages clean every created resource.
- [ ] Extend the Docker integration suite with real fixtures proving: raw public TCP fails after proxy variables are unset; metadata, host loopback/gateway, RFC1918, and direct-IP CONNECT fail; forbidden DNS fails and records deny; allowlisted HTTP and CONNECT succeed and record allow; a public-then-private rebinding answer is denied on its second request; destroy removes all resources idempotently.
- [ ] Run the unit suite and observe RED on the current `--network=bridge` behavior. Docker-dependent cases may skip locally but must be present before implementation.
- [ ] Implement a per-sandbox resource record `{ sandboxId, sidecarId, networkId }`. In allowlist mode: create `docker network create --internal`, create a hardened sidecar on bridge, connect it to the internal network, inspect its internal IP, create the sandbox only on the internal network with that DNS/proxy IP, then start both. Fail closed and clean in reverse order on every error.
- [ ] Implement `networkEvidence()` by parsing only schema-valid JSON lines from `docker logs`; malformed sidecar output is an execution error, not silently ignored.
- [ ] Add an executors build step before tests in CI so the compiled sidecar entry exists when real-Docker tests run.
- [ ] Run unit tests and typecheck locally; expect GREEN. Record that Docker integration execution is delegated to CI because the local daemon is unavailable.

---

### Task 4: Run dependency installs in a separately recorded policy mode

**Files:**

- Modify: `packages/contracts/src/sandbox.ts`
- Modify: `packages/domain/src/sandbox-runner.ts`
- Modify: `packages/executors/src/preview-command-plan.ts`
- Modify: `packages/executors/src/preview-command-plan.test.ts`
- Modify: `packages/executors/src/node-preview-runner.ts`
- Modify: `packages/executors/src/node-preview-runner.test.ts`
- Create: `packages/executors/src/docker-preview-installer.ts`
- Create: `packages/executors/src/docker-preview-installer.test.ts`

**Interfaces:**

```ts
export interface PreviewInstaller {
  install(input: {
    plan: PreviewCommandPlan;
    workspacePath: string;
    signal?: AbortSignal;
  }): Promise<PreviewInstallOutcome>;
}
export interface NodePreviewRunnerOptions {
  installer: PreviewInstaller;
}
```

- [ ] Add RED tests proving `NodePreviewRunner.prepare()` delegates installation to its injected installer, records success/failure plus redacted network evidence, and never calls the prior host `execa` path. Add Docker installer tests proving its spec uses `purpose: 'dependency-install'`, a registry-specific allowlist, a controlled workspace mount, and cleanup in `finally`.
- [ ] Extend sandbox exec with an optional absolute in-container `cwd`; validate it, pass it as Docker `-w`, and keep `/workspace` as the default.
- [ ] Implement `DockerPreviewInstaller` using `DockerSandboxRunner`: mount the candidate workspace at `/project`, execute the already-resolved lockfile command at `/project`, collect network evidence, destroy the sandbox, and return a bounded/redacted outcome. No command fallback is permitted.
- [ ] Make `NodePreviewRunner` require an installer dependency in composition and update tests/harnesses with explicit fakes. Wire production composition to `DockerPreviewInstaller`; if Docker/policy startup fails, the preview enters `PREVIEW_INSTALL_FAILED` rather than installing on the host.
- [ ] Run `npx vitest run packages/executors/src/preview-command-plan.test.ts packages/executors/src/docker-preview-installer.test.ts packages/executors/src/node-preview-runner.test.ts` and executors/composition typechecks; expect GREEN.

---

### Task 5: Put Chromium behind the same resolve-and-pin policy

**Files:**

- Modify: `packages/executors/src/browser-verifier.ts`
- Modify: `packages/executors/src/browser-verifier.test.ts`
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/orchestrator/src/browser-verification-coordinator.ts`
- Modify: `packages/orchestrator/src/browser-verification-coordinator.test.ts`

**Interfaces:**

```ts
const proxy = await createNetworkPolicyProxy({
  policy: { mode: 'allowlist', purpose: 'browser', allowedHosts },
  privateExceptions: new Set([`${previewUrl.hostname}:${effectivePort(previewUrl)}`]),
  onEvent: (event) => events.push(event),
});
browser = await chromium.launch({ headless: true, proxy: { server: proxy.url } });
```

- [ ] Add RED real-browser tests: the exact preview loopback origin remains available; an allowlisted hostname resolving to loopback/RFC1918/metadata is blocked; public-first/private-second rebinding is blocked on the second request; redirects and WebSockets are rechecked; a sentinel private server receives no request. Cover `captureSelectionScreenshot` through the proxy too.
- [ ] Preserve route-level exact-origin and preview-prefix checks as defense in depth, but launch Chromium with the local policy proxy and collect bounded browser network events in verification evidence.
- [ ] Treat only the system-supplied preview host+port as a private exception. Never copy user-configured origins into `privateExceptions`.
- [ ] Ensure proxy closure happens in `finally` beside browser/context closure, including timeout, abort, launch failure, and screenshot capture.
- [ ] Run `npx vitest run packages/executors/src/browser-verifier.test.ts packages/orchestrator/src/browser-verification-coordinator.test.ts`; expect GREEN.

---

### Task 6: Document, validate, review, publish, and attach evidence

**Files:**

- Create: `docs/adr/0028-deny-by-default-network-policy.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/VALIDATION.md`
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/evidence/issue-48-network-policy.md`

- [ ] Document topology, exact trust boundary, DNS rebinding defense, HTTPS visibility limit, dependency-install mode, browser preview exception, migration, rollback-by-revert, and the remaining secret-broker prerequisite before changing the default agent execution plane.
- [ ] Add a sanitized evidence report mapping every issue acceptance criterion and mandatory test (SSRF, DNS rebinding, private IP) to its test file/name and command. Capture a screenshot of that rendered report for the PR comment; do not expose host paths or secrets.
- [ ] Run focused security suites, `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check`. Restore any generated `apps/web/next-env.d.ts` quote drift before committing.
- [ ] Commit the implementation on `agent/issue-48-network-policy`, push that branch, and create one PR with `Fixes #48`, architecture/security/rollback notes, and the exact test evidence.
- [ ] Run `ponytail:ponytail-review` full and `code-simplifier-v2` on the PR diff. For each concrete finding, first add or identify a regression test, make the smallest correction, rerun focused and full gates, then push.
- [ ] Upload the evidence screenshot in a PR comment. Verify live GitHub checks, review threads, PR mergeability, and the issue linkage before reporting completion.
