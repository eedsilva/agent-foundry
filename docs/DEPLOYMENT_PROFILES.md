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

## `isolated-preview`

- Ephemeral rootless sandbox per run.
- No host home, CLI credential directory, Docker socket, or ambient cloud credentials.
- CPU, memory, PID, disk, output, and wall-clock limits.
- Egress denied by default with audited allowlists.
- Artifacts and logs leave the sandbox through an authenticated, redacted channel.

Required before exposing generated preview or verifier execution beyond a trusted local operator.

## `hosted-multi-tenant`

- Distributed control and execution planes.
- Tenant-scoped data, queue, artifact, sandbox, secret, observability, and billing boundaries.
- Short-lived credentials and policy enforcement independent of the model/provider.
- Abuse controls, incident response, retention, deletion, and SLOs.

No environment should claim this profile until the Hosted Platform v2 launch gates pass.
