export type DeploymentProfile =
  | 'development'
  | 'real-local-trusted'
  | 'mock-production';

export interface DeploymentProfileSpec {
  name: DeploymentProfile;
  executorMode: 'real' | 'mock';
  apiHost: string; // loopback or remote
  allowRemoteExecution: boolean;
  description: string;
}

const PROFILES: Record<DeploymentProfile, DeploymentProfileSpec> = {
  'development': {
    name: 'development',
    executorMode: 'mock',
    apiHost: '127.0.0.1',
    allowRemoteExecution: false,
    description: 'Local development with mock execution mode (no real CLI)',
  },
  'real-local-trusted': {
    name: 'real-local-trusted',
    executorMode: 'real',
    apiHost: '127.0.0.1',
    allowRemoteExecution: false,
    description: 'Trusted local environment with real CLI execution on loopback only',
  },
  'mock-production': {
    name: 'mock-production',
    executorMode: 'mock',
    apiHost: '0.0.0.0', // binds all interfaces
    allowRemoteExecution: false,
    description: 'Production-ready with mock execution mode (safe for public hosts)',
  },
};

export function getDeploymentProfile(executorMode: string, apiHost: string, allowRemoteExecution: boolean): DeploymentProfileSpec | null {
  for (const profile of Object.values(PROFILES)) {
    if (
      profile.executorMode === executorMode &&
      profile.apiHost === apiHost &&
      profile.allowRemoteExecution === allowRemoteExecution
    ) {
      return profile;
    }
  }
  return null;
}

export function listDeploymentProfiles(): DeploymentProfileSpec[] {
  return Object.values(PROFILES);
}
