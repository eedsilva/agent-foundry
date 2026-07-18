# Deployment Profiles

Deployment profiles are configuration presets that encode security assumptions about where Agent Foundry runs and what execution modes are enabled.

## Available Profiles

### development

**Executor Mode:** mock  
**API Host:** 127.0.0.1 (loopback)  
**Remote Execution:** ❌ disabled

Local development with mock CLI execution (no real commands run). Safe for shared machines.

**Use case:** Development, debugging, demo with fake execution.

**Configuration:**

```bash
EXECUTOR_MODE=mock
API_HOST=127.0.0.1
ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=false
```

### real-local-trusted ✓ (MAX BEFORE v0.4.5)

**Executor Mode:** real  
**API Host:** 127.0.0.1 (loopback only)  
**Remote Execution:** ❌ disabled

Trusted local environment with real CLI execution. Restricts API to loopback interface for host-level isolation.

**Use case:** Local development with real command execution, personal laptop, trusted server.

**Security:** Real mode is **only** accessible from the same machine (127.0.0.1, localhost, ::1). Remote network access is denied at startup.

**Configuration:**

```bash
EXECUTOR_MODE=real
API_HOST=127.0.0.1
ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=false
```

### mock-production

**Executor Mode:** mock  
**API Host:** 0.0.0.0 (all interfaces)  
**Remote Execution:** ❌ disabled

Production-ready deployment with mock CLI execution. Safe for public-facing deployments since all execution is simulated.

**Use case:** Production, shared hosting, untrusted networks, public demo.

**Security:** Execution is mocked (no real commands). Public access is safe.

**Configuration:**

```bash
EXECUTOR_MODE=mock
API_HOST=0.0.0.0
ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=false
```

## Real Mode Security Model

**Default:** API binds to loopback (127.0.0.1) when `EXECUTOR_MODE=real`.

**Remote Host Binding Rejected:** If you set `API_HOST=0.0.0.0` or any non-loopback IP with `EXECUTOR_MODE=real`, startup fails:

```
Error: Refusing to expose real CLI execution on a non-loopback API host.
Keep API_HOST on 127.0.0.1/localhost or explicitly set ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=true
after accepting the host-level risk.
```

**Override (⚠️ unsafe):** Set `ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=true` to bind real mode to non-loopback hosts. This exposes real command execution to untrusted network. Startup logs a security warning.

## Deployment Profile Detection

On startup, the runtime detects your deployment profile from environment variables and logs it:

```
[info] Deployment profile: real-local-trusted
[info] API listening on 127.0.0.1:4000
```

If your configuration matches a known profile, the name is logged. If it's a custom combination, logged as "custom".

## Startup Warnings

**Real mode with remote override:**

```
SECURITY WARNING: real CLI execution is exposed on a non-loopback host with an explicit unsafe override.
```

This warning appears every startup as a reminder that the environment is configured with reduced safety.

## Changing Profiles

Profiles are determined at startup from environment variables. To switch profiles:

1. Update `.env` or export environment variables
2. Stop the server
3. Start the server (new profile is detected and logged)

## Related Documentation

- [RISK_REGISTER.md](./RISK_REGISTER.md) — Operational risks and mitigations
- [Configuration Reference](./docs/CONFIGURATION.md) — All environment variables
