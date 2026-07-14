import type {
  Project,
  ProjectDetailResponse,
  ResumeBlockedResponse,
  RetryPlanResponse,
  RetryStepRequest,
  RunDetailResponse,
  RuntimeInfoResponse,
  WorkflowRun,
} from '@agent-foundry/contracts';

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

export function getRunDetail(runId: string): Promise<RunDetailResponse> {
  return api<RunDetailResponse>(`/runs/${encodeURIComponent(runId)}`);
}

export async function pauseRun(runId: string): Promise<WorkflowRun> {
  const response = await api<{ run: WorkflowRun }>(`/runs/${encodeURIComponent(runId)}/pause`, {
    method: 'POST',
  });
  return response.run;
}

export async function resumeRun(
  runId: string,
): Promise<{ run?: WorkflowRun; blocked?: ResumeBlockedResponse }> {
  const response = await fetch(`${API_URL}/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => null)) as
    (ResumeBlockedResponse & { run?: WorkflowRun; message?: string }) | null;
  if (response.status === 409 && body?.error === 'ResumeBlockedError') return { blocked: body };
  if (!response.ok) throw new Error(body?.message ?? `API request failed with ${response.status}`);
  return body?.run ? { run: body.run } : {};
}

export function getRetryPlan(runId: string, stepRunId: string): Promise<RetryPlanResponse> {
  return api<RetryPlanResponse>(
    `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepRunId)}/retry-plan`,
  );
}

export async function retryStep(
  runId: string,
  stepRunId: string,
  input: RetryStepRequest,
): Promise<WorkflowRun> {
  const response = await api<{ run: WorkflowRun }>(
    `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepRunId)}/retry`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.run;
}
