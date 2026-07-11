import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRole,
  ArtifactMetadata,
  ExecutorHealth,
  ModelDefinition,
  ModelMetric,
  Project,
  ProjectEvent,
  QueueJob,
  RouteDecision,
  StoredArtifact,
  TaskKind,
  TaskProfile,
  VerificationReport,
  WorkflowDefinition,
} from '@agent-foundry/contracts';

export interface ProjectRepository {
  create(project: Project): Promise<void>;
  get(projectId: string): Promise<Project | null>;
  update(project: Project): Promise<void>;
  list(limit?: number): Promise<Project[]>;
}

export interface ArtifactStore {
  put(input: {
    projectId: string;
    name: string;
    content: unknown;
    contentType?: string;
    createdBy: string;
    runId?: string;
    routeDecision?: RouteDecision;
  }): Promise<StoredArtifact>;
  getLatest(projectId: string, name: string): Promise<StoredArtifact | null>;
  getRevision(projectId: string, name: string, revision: number): Promise<StoredArtifact | null>;
  listLatest(projectId: string): Promise<StoredArtifact[]>;
  listMetadata(projectId: string, name?: string): Promise<ArtifactMetadata[]>;
}

export interface EventStore {
  append(event: ProjectEvent): Promise<void>;
  list(projectId: string, limit?: number): Promise<ProjectEvent[]>;
}

export interface JobQueue {
  enqueue(job: QueueJob): Promise<void>;
  claim(workerId: string): Promise<QueueJob | null>;
  ack(job: QueueJob, workerId: string): Promise<void>;
  nack(job: QueueJob, workerId: string, error: Error): Promise<void>;
}

export interface WorkflowRepository {
  get(workflowId: string): Promise<WorkflowDefinition>;
  list(): Promise<WorkflowDefinition[]>;
}

export interface HarnessSelection {
  version: string;
  files: Array<{
    path: string;
    content: string;
    priority: number;
  }>;
  combined: string;
}

export interface HarnessRepository {
  select(input: {
    role: AgentRole;
    taskKind: TaskKind;
    stack: string;
    tags: string[];
  }): Promise<HarnessSelection>;
}

export interface ModelRouter {
  route(profile: TaskProfile): Promise<RouteDecision>;
  catalog(): Promise<ModelDefinition[]>;
}

export interface MetricsRepository {
  get(modelId: string, taskKind: TaskKind, role: AgentRole): Promise<ModelMetric | null>;
  record(input: {
    modelId: string;
    taskKind: TaskKind;
    role: AgentRole;
    success: boolean;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  }): Promise<void>;
  recordQuality(input: {
    modelId: string;
    taskKind: TaskKind;
    role: AgentRole;
    approved: boolean;
  }): Promise<void>;
}

export interface AgentExecutor {
  readonly provider: string;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
  health(): Promise<ExecutorHealth>;
}

export interface ExecutorRegistry {
  get(provider: string): AgentExecutor;
  health(): Promise<ExecutorHealth[]>;
}

export interface VerificationService {
  verify(input: {
    workspacePath: string;
    scripts: string[];
    includeGitDiffCheck: boolean;
  }): Promise<VerificationReport>;
}

export interface WorkspaceManager {
  projectRoot(projectId: string): string;
  workspacePath(projectId: string): string;
  ensure(projectId: string): Promise<void>;
  writePrd(projectId: string, prd: string): Promise<void>;
  writeRunContext(input: {
    projectId: string;
    runId: string;
    requestMarkdown: string;
    outputSchema: Record<string, unknown>;
  }): Promise<{ requestPath: string; schemaPath: string }>;
  ensureGit(projectId: string): Promise<void>;
  checkpoint(projectId: string, label: string): Promise<string>;
  rollback(projectId: string, ref: string): Promise<void>;
  commit(projectId: string, message: string): Promise<string | null>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
