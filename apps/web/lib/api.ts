import type { Project, ProjectDetailResponse, RuntimeInfoResponse } from '@agent-foundry/contracts';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `API request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function createProject(input: {
  name: string;
  prd: string;
  workflowId: string;
}): Promise<Project> {
  const response = await api<{ project: Project }>('/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.project;
}

export async function listProjects(): Promise<Project[]> {
  const response = await api<{ projects: Project[] }>('/projects');
  return response.projects;
}

export function getProject(id: string): Promise<ProjectDetailResponse> {
  return api<ProjectDetailResponse>(`/projects/${encodeURIComponent(id)}`);
}

export function getRuntime(): Promise<RuntimeInfoResponse> {
  return api<RuntimeInfoResponse>('/runtime');
}

export async function retryProject(id: string): Promise<Project> {
  const response = await api<{ project: Project }>(`/projects/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });
  return response.project;
}
