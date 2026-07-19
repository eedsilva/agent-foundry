# Risk Register

Living document of identified operational risks and mitigations for Agent Foundry.

## Risk Fields

- **id:** Unique risk identifier (risk-NNN)
- **title:** One-line risk description
- **owner:** Team or role responsible for mitigation
- **trigger:** Condition or event that activates the risk
- **probability:** low | medium | high | critical
- **impact:** low | medium | high | critical
- **mitigation:** Current controls reducing risk
- **contingency:** Response plan if risk occurs
- **status:** active | monitoring | mitigated

## Active Risks

See `packages/composition/src/risk-register.ts` for the authoritative register.

### RISK-001: Exposed Secrets in Environment Configuration

**Owner:** DevOps  
**Probability:** High | **Impact:** Critical

**Trigger:** Real mode execution with API host ≠ loopback AND ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=true

**Mitigation:** API binds to loopback by default. Real mode throws on non-loopback unless override set. Override requires explicit env var.

**Contingency:** Rotate all exposed credentials. Audit API access logs.

---

### RISK-002: Prompt Injection via User Input in Real CLI Mode

**Owner:** Security  
**Probability:** High | **Impact:** Critical

**Trigger:** Executor mode = real AND untrusted user input reaches CLI

**Mitigation:** Real mode restricted to loopback by default. Input validation in orchestrator. Mock mode for untrusted environments.

**Contingency:** Disable real mode. Audit execution logs. Review injected commands.

---

### RISK-003: Provider API Key Exposure in Logs or Artifacts

**Owner:** Platform  
**Probability:** Medium | **Impact:** Critical

**Trigger:** Real execution with provider keys AND logs/artifacts stored insecurely

**Mitigation:** Provider keys masked in logs. Artifacts stored locally. Keys never logged in plan execution.

**Contingency:** Rotate provider keys. Audit artifact access. Enable encryption.

---

### RISK-004: Mutable Fallback Providers Allow Unexpected Code Execution

**Owner:** Platform  
**Probability:** Low | **Impact:** High

**Trigger:** Real mode with fallback provider config AND main provider unavailable

**Mitigation:** Fallback providers explicitly configured. Real mode only on trusted hosts. Warnings logged.

**Contingency:** Kill execution. Review fallback config. Restrict provider availability.

---

### RISK-005: Artifacts Stored in Accessible Location

**Owner:** Platform  
**Probability:** Low | **Impact:** High

**Trigger:** Real mode with artifact collection AND .data/ writable by untrusted user

**Mitigation:** Artifacts stored in .data/. Real mode restricted to loopback. Reaper deletes old artifacts.

**Contingency:** Review artifact contents. Enable encryption. Restrict permissions.

---

## Review Cycle

Risk register reviewed quarterly by platform team. New risks added as discovered. Mitigations updated when controls change.
