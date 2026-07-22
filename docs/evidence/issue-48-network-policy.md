# Issue #48 — deny-by-default network-policy evidence

Date: 2026-07-22

## Acceptance mapping

| Intent                                                     | Implemented boundary                                                                                        | Automated evidence                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No egress without an allowlist                             | `none` uses no network; `allowlist` requires an internal policy-network attachment                          | `docker-sandbox-runner.test.ts` — fail-closed attachment and no bridge; integration — raw `1.1.1.1:80` denied |
| Observable DNS and HTTP policy                             | UDP DNS plus HTTP/CONNECT sidecar emit bounded schema-validated events                                      | `network-policy-dns.test.ts`, `network-policy-proxy.test.ts`, Docker integration audit assertions             |
| Block metadata, private ranges, and host loopback          | Address classifier rejects IPv4/IPv6 special ranges; sandbox has no external route                          | `network-policy.test.ts` tables, metadata proxy denial, private browser sentinel receives zero requests       |
| Separate dependency-install mode                           | Real preview install uses `DockerPreviewInstaller` with purpose `dependency-install` and registry allowlist | `docker-preview-installer.test.ts`, `node-preview-runner.test.ts` durable event assertion                     |
| Browser only reaches preview and authorized public origins | Chromium uses policy proxy; only exact system preview authority is a private exception                      | `browser-verifier.test.ts` exact preview allow + separately allowed private-origin deny                       |
| SSRF                                                       | Literal IP, Host mismatch, metadata, mixed public/private DNS, and raw socket paths fail closed             | `network-policy-proxy.test.ts`, `network-policy.test.ts`, Docker integration                                  |
| DNS rebinding                                              | Every connection re-resolves; any private answer is denied; connection uses the validated literal IP        | `network-policy.test.ts` public-first/private-second regression and connector spy                             |
| Private IP access                                          | RFC1918, link-local, CGNAT, loopback, reserved, ULA, mapped IPv6, and metadata ranges denied                | `network-policy.test.ts` address table and browser private sentinel                                           |

## Focused results

- Network-policy contracts: 50 tests passed.
- Policy core/DNS/proxy/coordinator: 51 tests passed.
- Docker runner/sidecar/lifecycle unit: 27 tests passed; 18 real-Docker tests are present and skipped only when the daemon is unavailable.
- Chromium verifier: 65 tests passed, including the preview exception, private-origin denial, bounded evidence, and proxy-startup cleanup.
- Root TypeScript project-reference typecheck passed.
- Root `npm run check`: formatting, lint, architecture/governance checks, typecheck, 1,396 unit tests, 56 script tests, and all package/app production builds passed.
- API Playwright e2e: 12/12 tests passed in 45.8 seconds.
- `npm run doctor`: environment ready in mock mode; Node, Git, harness, workflows, catalog, Codex, and Claude checks passed.

## Security, migration, and rollback

- HTTPS is observed at CONNECT hostname/port; payload interception and a managed CA are deliberately out of scope.
- Events exclude URL path/query, headers, cookies, credentials, and bodies.
- Every policy evidence path is capped at 1,000 events, including sidecar logs, browser events, schemas, and persisted command-plan evidence.
- Policy sidecars and allowlisted sandboxes use Docker auto-removal plus a bounded TTL. Labeled expired networks are swept on later creates; networks with active endpoints are deferred without blocking new work.
- The non-root sidecar drops all capabilities and adds back only `NET_BIND_SERVICE`, which is required to provide DNS on port 53 inside the sandbox network.
- User-configured IP-literal/localhost browser origins now fail contract validation.
- Real preview installation now fails closed when Docker/policy initialization is unavailable. Controlled e2e fixtures opt into an injected local installer; production has no runtime fallback.
- Independent full-security review findings were addressed with regression tests for partial sidecar startup, cleanup retryability, orphan recovery, IPv6 special-use ranges, dependency-install evidence failure, and browser proxy leaks.
- Agent CLI execution remains on `LocalExecutionPlane` pending the secret broker. This PR does not overclaim host credential isolation.
- Rollback is a full revert. The internal-network sidecar must not be replaced with an ordinary bridge as a partial rollback.

## Validation commands

```bash
npx vitest run packages/contracts/src/execution-plane.test.ts packages/contracts/src/policy.test.ts packages/contracts/src/sandbox.test.ts
npx vitest run packages/executors/src/network-policy.test.ts packages/executors/src/network-policy-dns.test.ts packages/executors/src/network-policy-proxy.test.ts packages/executors/src/docker-sandbox-runner.test.ts packages/executors/src/docker-sandbox-runner.integration.test.ts packages/executors/src/docker-preview-installer.test.ts packages/executors/src/node-preview-runner.test.ts packages/executors/src/browser-verifier.test.ts packages/orchestrator/src/browser-verification-coordinator.test.ts
npm run check
npm run e2e --workspace @agent-foundry/api
npm run doctor
git diff --check
```
