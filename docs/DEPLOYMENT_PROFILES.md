# Deployment Profiles

Deployment profiles make trust assumptions explicit. A profile is a security contract, not a marketing tier.

## `mock-local`

- `EXECUTOR_MODE=mock`
- API may bind to a container-facing interface.
- No provider credentials or generated dependency installation.
- Suitable for CI, demos, and pipeline mechanics.

## `real-local-trusted`

- `EXECUTOR_MODE=real`
- API bound to `127.0.0.1`, `localhost`, or `::1`.
- One trusted operator and trusted repositories/PRDs.
- CLIs and verifier run with host-user capabilities.
- No claim of isolation against malicious code.

This is the only supported real-execution profile before Safe Runtime Foundation.

## `personal-local-builder`

- Personal Builder v1 control plane on macOS.
- API bound to loopback; one trusted operator.
- Locally authenticated Codex, Claude and AGY CLIs.
- Docker Desktop provides isolated per-project Supabase and preview environments.
- Local `.env` files provide trusted configuration and secrets.
- Generated code, verifier and preview run through `SandboxRunner`.
- Not suitable for remote users or untrusted PRDs.

This is the supported Agent Foundry v1 profile after Safe Runtime Foundation.

## `personal-vps-app`

- Runtime profile for a generated application, not for the Agent Foundry control plane.
- Existing Ubuntu LTS VPS over SSH; Debian-based hosts are best effort.
- Isolated Docker Compose project per app with Next.js, Supabase and Caddy routing.
- Host/port endpoint always available; custom domain optional after manual DNS configuration.
- Scheduled backups retained on the VPS and copied to the owner's Mac.
- Application rollback does not imply database rollback.

## `isolated-preview`

- Ephemeral rootless sandbox per run.
- No host home, CLI credential directory, Docker socket, or ambient cloud credentials.
- CPU, memory, PID, disk, output, and wall-clock limits.
- Egress denied by default with audited allowlists.
- Artifacts and logs leave the sandbox through an authenticated, redacted channel.

Required before running generated preview or verifier execution, including for the trusted local operator's v1 golden path.

## `hosted-multi-tenant`

- Distributed control and execution planes.
- Tenant-scoped data, queue, artifact, sandbox, secret, observability, and billing boundaries.
- Short-lived credentials and policy enforcement independent of the model/provider.
- Abuse controls, incident response, retention, deletion, and SLOs.

No environment should claim this profile until the Hosted Platform v2 launch gates pass.
