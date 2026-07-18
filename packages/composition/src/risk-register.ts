export type RiskProbability = 'low' | 'medium' | 'high' | 'critical';
export type RiskImpact = 'low' | 'medium' | 'high' | 'critical';

export interface Risk {
  id: string;
  title: string;
  owner: string; // team or role
  trigger: string; // condition that activates this risk
  probability: RiskProbability;
  impact: RiskImpact;
  mitigation: string; // current controls
  contingency: string; // response if risk occurs
  status: 'active' | 'monitoring' | 'mitigated'; // current status
}

export const INITIAL_RISKS: Risk[] = [
  {
    id: 'risk-001',
    title: 'Exposed secrets in environment configuration',
    owner: 'DevOps',
    trigger:
      'Real mode execution with API host != loopback AND ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=true',
    probability: 'high',
    impact: 'critical',
    mitigation:
      'API binds to loopback (127.0.0.1) by default. Real mode throws on non-loopback unless override set. Override requires explicit env var.',
    contingency: 'Rotate all exposed credentials immediately. Audit who accessed the API.',
    status: 'active',
  },
  {
    id: 'risk-002',
    title: 'Prompt injection via user input in real CLI mode',
    owner: 'Security',
    trigger: 'Executor mode = real AND untrusted user input reaches CLI',
    probability: 'high',
    impact: 'critical',
    mitigation:
      'Real mode restricted to loopback by default. Input validation in orchestrator. Mock mode for untrusted environments.',
    contingency: 'Disable real mode. Audit execution logs. Review injected commands.',
    status: 'active',
  },
  {
    id: 'risk-003',
    title: 'Provider API key exposure in logs or artifacts',
    owner: 'Platform',
    trigger: 'Real execution with provider keys configured AND logs/artifacts stored insecurely',
    probability: 'medium',
    impact: 'critical',
    mitigation:
      'Provider keys masked in logs. Artifacts stored in .data/ (local only by default). Keys never logged in plan execution.',
    contingency: 'Rotate provider keys. Audit artifact/log access. Enable encryption at rest.',
    status: 'active',
  },
  {
    id: 'risk-004',
    title: 'Mutable fallback providers allow unexpected code execution',
    owner: 'Platform',
    trigger: 'Real mode with fallback provider configuration AND main provider unavailable',
    probability: 'low',
    impact: 'high',
    mitigation:
      'Fallback providers explicitly configured. Real mode only on trusted hosts. Warnings logged on fallback.',
    contingency: 'Kill the execution. Review fallback config. Restrict provider availability.',
    status: 'monitoring',
  },
  {
    id: 'risk-005',
    title: 'Artifacts (screenshots, traces, videos) stored in accessible location',
    owner: 'Platform',
    trigger: 'Real mode with artifact collection AND .data/ directory writable by untrusted user',
    probability: 'low',
    impact: 'high',
    mitigation:
      'Artifacts stored in .data/ by default (local). Real mode restricted to loopback. Reaper deletes old artifacts.',
    contingency: 'Review artifact contents. Enable encryption. Restrict .data/ permissions.',
    status: 'monitoring',
  },
];

export function getRiskById(id: string): Risk | undefined {
  return INITIAL_RISKS.find((r) => r.id === id);
}

export function listRisks(filter?: { owner?: string; status?: string }): Risk[] {
  return INITIAL_RISKS.filter((r) => {
    if (filter?.owner && r.owner !== filter.owner) return false;
    if (filter?.status && r.status !== filter.status) return false;
    return true;
  });
}
