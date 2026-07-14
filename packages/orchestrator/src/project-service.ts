import type {
  CreateProjectRequest,
  Project,
  ProjectDetailResponse,
  ProjectEvent,
  QueueJob,
  WorkflowRun,
} from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  Clock,
  EventStore,
  IdGenerator,
  JobQueue,
  ProjectRepository,
  WorkspaceManager,
  WorkflowRunRepository,
  WorkflowRepository,
} from '@agent-foundry/domain';
import { NotFoundError } from '@agent-foundry/domain';

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly queue: JobQueue,
    private readonly workflows: WorkflowRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateProjectRequest): Promise<Project> {
    await this.workflows.get(input.workflowId);
    const now = this.clock.now().toISOString();
    const projectId = this.ids.next();
    const runId = this.ids.next();
    const project: Project = {
      id: projectId,
      name: input.name,
      workflowId: input.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
      currentRunId: runId,
    };
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: input.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.workspaces.ensure(project.id);
    await this.workspaces.writePrd(project.id, input.prd);
    await this.projects.create(project);
    await this.runs.create(run);
    await this.artifacts.put({
      projectId: project.id,
      name: 'prd',
      content: input.prd,
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    await this.appendEvent(project.id, 'project.created', 'Project and workspace created.');

    const job: QueueJob = {
      id: this.ids.next(),
      type: 'run-project',
      projectId: project.id,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    };
    await this.queue.enqueue(job);
    await this.appendEvent(project.id, 'project.queued', 'Project queued for orchestration.');
    return project;
  }

  async get(projectId: string): Promise<ProjectDetailResponse> {
    const project = await this.requireProject(projectId);
    const [artifacts, events] = await Promise.all([
      this.artifacts.listLatest(projectId),
      this.events.list(projectId),
    ]);
    return { project, artifacts, events };
  }

  async list(limit = 50): Promise<Project[]> {
    return this.projects.list(limit);
  }

  async getArtifact(projectId: string, name: string, revision?: number) {
    await this.requireProject(projectId);
    const artifact = revision
      ? await this.artifacts.getRevision(projectId, name, revision)
      : await this.artifacts.getLatest(projectId, name);
    if (!artifact) throw new NotFoundError(`Artifact ${name} not found in project ${projectId}`);
    return artifact;
  }

  async retry(projectId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status === 'running') return project;
    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;
    const saved = await this.projects.update(updated, project.version);
    await this.queue.enqueue({
      id: this.ids.next(),
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });
    await this.appendEvent(projectId, 'project.queued', 'Project manually re-queued.');
    return saved;
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    return project;
  }

  private async appendEvent(
    projectId: string,
    type: ProjectEvent['type'],
    message: string,
  ): Promise<void> {
    await this.events.append({
      id: this.ids.next(),
      projectId,
      type,
      createdAt: this.clock.now().toISOString(),
      message,
      data: {},
    });
  }
}
