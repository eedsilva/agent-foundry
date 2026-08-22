# Security Policy

Do not open a public issue for a vulnerability that could expose credentials, execute code outside the intended workspace, escape a sandbox, cross tenant boundaries, or disclose private project data.

Use the repository's **Security → Report a vulnerability** private advisory flow. Include affected revision, deployment profile, reproduction steps, impact, and any known containment.

## Supported security posture

The current `v0.1.x` line is a local, trusted-user MVP. `EXECUTOR_MODE=real` invokes authenticated CLIs and may execute generated scripts with the host user's permissions. It is not a safe public multi-tenant service.

The control plane binds only to loopback. Startup rejects non-loopback `API_HOST` values in both mock and real execution modes; there is no remote-binding override.

See [docs/SECURITY.md](docs/SECURITY.md), [docs/DEPLOYMENT_PROFILES.md](docs/DEPLOYMENT_PROFILES.md), and [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md).
