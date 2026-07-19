import type {
  ApprovalConflictResponse,
  ApprovalListResponse,
  ClassifyMessageResponse,
  ConversationPageResponse,
  CreateMessageRequest,
  CreateModelOverrideRequest,
  CreateModelOverrideResponse,
  DecideApprovalRequest,
  DecideApprovalResponse,
  DecideChangeRequestRequest,
  DecideChangeRequestResponse,
  DiscardDraftRequest,
  DraftDetailResponse,
  Message,
  Operation,
  PreviewLogPage,
  PreviewSession,
  Project,
  ProjectDetailResponse,
  ProjectVersion,
  ResumeBlockedResponse,
  RetryPlanResponse,
  RetryProjectRequest,
  RetryStepRequest,
  RunDetailResponse,
  RuntimeInfoResponse,
  StartOperationRequest,
  StoredArtifact,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
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

export function eventStreamUrl(id: string): string {
  return `${API_URL}/projects/${encodeURIComponent(id)}/events/stream`;
}

export async function retryProject(id: string, input?: RetryProjectRequest): Promise<Project> {
  const response = await api<{ project: Project }>(`/projects/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  return response.project;
}

export function getRunDetail(runId: string): Promise<RunDetailResponse> {
  return api<RunDetailResponse>(`/runs/${encodeURIComponent(runId)}`);
}

export function getDraft(runId: string): Promise<DraftDetailResponse> {
  return api<DraftDetailResponse>(`/runs/${encodeURIComponent(runId)}/draft`);
}

export async function discardDraft(
  runId: string,
  input: DiscardDraftRequest,
): Promise<WorkflowRun> {
  const response = await api<{ run: WorkflowRun }>(
    `/runs/${encodeURIComponent(runId)}/draft/discard`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.run;
}

export function createModelOverride(
  runId: string,
  input: CreateModelOverrideRequest,
): Promise<CreateModelOverrideResponse> {
  return api<CreateModelOverrideResponse>(`/runs/${encodeURIComponent(runId)}/model-overrides`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
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

export async function listApprovals(runId: string): Promise<ApprovalListResponse['approvals']> {
  const response = await api<ApprovalListResponse>(`/runs/${encodeURIComponent(runId)}/approvals`);
  return response.approvals;
}

export async function decideApproval(
  runId: string,
  requestId: string,
  input: DecideApprovalRequest,
): Promise<{ result?: DecideApprovalResponse; conflict?: ApprovalConflictResponse }> {
  const response = await fetch(
    `${API_URL}/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}/decide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(input),
    },
  );
  const body = (await response.json().catch(() => null)) as
    (ApprovalConflictResponse & DecideApprovalResponse & { message?: string }) | null;
  if (response.status === 409 && body?.error === 'ApprovalConflictError') return { conflict: body };
  if (!response.ok) throw new Error(body?.message ?? `API request failed with ${response.status}`);
  return { result: body as unknown as DecideApprovalResponse };
}

export function getArtifact(
  projectId: string,
  name: string,
  revision?: number,
): Promise<StoredArtifact> {
  const query = revision ? `?revision=${revision}` : '';
  return api<StoredArtifact>(
    `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(name)}${query}`,
  );
}

export function getArtifactBlobUrl(projectId: string, name: string, revision?: number): string {
  const query = revision ? `?revision=${revision}` : '';
  return `${API_URL}/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(name)}/blob${query}`;
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const response = await api<{ workflows: WorkflowDefinition[] }>('/workflows');
  return response.workflows;
}

export async function listVersions(projectId: string, limit?: number): Promise<ProjectVersion[]> {
  const query = limit ? `?limit=${limit}` : '';
  const response = await api<{ versions: ProjectVersion[] }>(
    `/projects/${encodeURIComponent(projectId)}/versions${query}`,
  );
  return response.versions;
}

export function compareVersions(
  projectId: string,
  from: string,
  to: string,
): Promise<{ diff: string }> {
  return api<{ diff: string }>(
    `/projects/${encodeURIComponent(projectId)}/versions/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

export async function revertToVersion(
  projectId: string,
  versionId: string,
): Promise<ProjectVersion> {
  const response = await api<{ version: ProjectVersion }>(
    `/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/revert`,
    { method: 'POST' },
  );
  return response.version;
}

export function branchFromVersion(
  projectId: string,
  versionId: string,
  label?: string,
): Promise<{ branchName: string; version: ProjectVersion }> {
  return api<{ branchName: string; version: ProjectVersion }>(
    `/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/branch`,
    { method: 'POST', body: JSON.stringify({ label }) },
  );
}

export async function setVersionProtected(
  projectId: string,
  versionId: string,
  protectedFlag: boolean,
): Promise<ProjectVersion> {
  const response = await api<{ version: ProjectVersion }>(
    `/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/protect`,
    { method: 'POST', body: JSON.stringify({ protected: protectedFlag }) },
  );
  return response.version;
}

export function getConversation(projectId: string): Promise<ConversationPageResponse> {
  return api<ConversationPageResponse>(`/projects/${encodeURIComponent(projectId)}/conversation`);
}

export async function sendMessage(
  projectId: string,
  input: CreateMessageRequest,
): Promise<Message> {
  const response = await api<{ message: Message }>(
    `/projects/${encodeURIComponent(projectId)}/conversation/messages`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.message;
}

export async function startOperation(
  projectId: string,
  messageId: string,
  input: StartOperationRequest,
): Promise<Operation> {
  const response = await api<{ operation: Operation }>(
    `/projects/${encodeURIComponent(projectId)}/conversation/messages/${encodeURIComponent(messageId)}/operations`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.operation;
}

export async function decideOperation(
  projectId: string,
  operationId: string,
  action: 'approve' | 'reject',
): Promise<Operation> {
  const response = await api<{ operation: Operation }>(
    `/projects/${encodeURIComponent(projectId)}/conversation/operations/${encodeURIComponent(operationId)}/decide`,
    { method: 'POST', body: JSON.stringify({ action }) },
  );
  return response.operation;
}

export function classifyMessage(
  projectId: string,
  messageId: string,
): Promise<ClassifyMessageResponse> {
  return api<ClassifyMessageResponse>(
    `/projects/${encodeURIComponent(projectId)}/conversation/messages/${encodeURIComponent(messageId)}/classify`,
    { method: 'POST' },
  );
}

export function decideChangeRequest(
  projectId: string,
  changeRequestId: string,
  input: DecideChangeRequestRequest,
): Promise<DecideChangeRequestResponse> {
  return api<DecideChangeRequestResponse>(
    `/projects/${encodeURIComponent(projectId)}/conversation/change-requests/${encodeURIComponent(changeRequestId)}/decide`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function getActivePreviewSession(
  projectId: string,
): Promise<{ session: PreviewSession | null }> {
  return api<{ session: PreviewSession | null }>(
    `/projects/${encodeURIComponent(projectId)}/preview/active`,
  );
}

export function startPreview(projectId: string): Promise<{ session: PreviewSession; url: string }> {
  return api<{ session: PreviewSession; url: string }>(
    `/projects/${encodeURIComponent(projectId)}/preview`,
    { method: 'POST' },
  );
}

export function stopPreview(
  projectId: string,
  sessionId: string,
): Promise<{ session: PreviewSession }> {
  return api<{ session: PreviewSession }>(
    `/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(sessionId)}/stop`,
    { method: 'POST' },
  );
}

export function getPreviewLogs(
  projectId: string,
  sessionId: string,
  cursor?: number,
): Promise<PreviewLogPage> {
  const query = cursor !== undefined ? `?cursor=${cursor}` : '';
  return api<PreviewLogPage>(
    `/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(sessionId)}/logs${query}`,
  );
}
