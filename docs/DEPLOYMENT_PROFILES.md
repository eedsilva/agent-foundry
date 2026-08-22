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
```

### real-local-trusted

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
```

## Control Plane Security Model

**Default:** API binds to loopback (`127.0.0.1`) in every execution mode.

**Remote Host Binding Rejected:** Any non-loopback `API_HOST` fails startup:

```
Error: Refusing to expose the Agent Foundry control plane on a non-loopback API host.
Keep API_HOST on 127.0.0.1, localhost, or ::1.
```

No remote-binding override exists. The Control Session authenticates browser requests but does not make remote exposure supported.

## Deployment Profile Detection

On startup, the runtime detects your deployment profile from environment variables and logs it:

```
[info] Deployment profile: real-local-trusted
[info] API listening on 127.0.0.1:4000
```

If your configuration matches a known profile, the name is logged. If it's a custom combination, logged as "custom".

## Changing Profiles

Profiles are determined at startup from environment variables. To switch profiles:

1. Update `.env` or export environment variables
2. Stop the server
3. Start the server (new profile is detected and logged)

## Related Documentation

- [RISK_REGISTER.md](./RISK_REGISTER.md) — Operational risks and mitigations
- [Configuration Reference](./docs/CONFIGURATION.md) — All environment variables
