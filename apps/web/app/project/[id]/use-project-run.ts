'use client';

import { useEffect, useState } from 'react';
import {
  isWorkflowRunStatusTerminal,
  type ApprovalListResponse,
  type ModelDefinition,
  type ProjectEvent,
  type RunDetailResponse,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  eventStreamUrl,
  getProject,
  getRunDetail,
  getRuntime,
  listApprovals,
  listWorkflows,
} from '../../../lib/api';
import { mergeEvents } from '../../../lib/events';

const PROJECT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/**
 * Everything the builder page polls or streams about the project itself: the
 * project detail + run detail + approvals poll, the project event stream, the
 * workflow definition, the runtime model catalogue and the poll for the run
 * behind the latest conversation operation. These five effects share `detail`,
 * `events` and `error`, so they stay together. Moved verbatim out of `page.tsx`
 * in Task 4b — same bodies, same intervals, same dependency arrays.
 */
export function useProjectRun(id: string, latestOperationRunId: string | undefined) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getProject>> | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [live, setLive] = useState(false);
  const [activeOperationRun, setActiveOperationRun] = useState<RunDetailResponse | null>(null);
  const [approvals, setApprovals] = useState<ApprovalListResponse['approvals']>([]);
  const [workflowDef, setWorkflowDef] = useState<WorkflowDefinition | null>(null);
  const [runtimeModels, setRuntimeModels] = useState<ModelDefinition[]>([]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getProject(id);
        if (!active) return;
        setDetail(next);
        setEvents((current) => mergeEvents(current, next.events));
        if (next.project.currentRunId) {
          const run = await getRunDetail(next.project.currentRunId);
          if (!active) return;
          setRunDetail(run);
          const approvalsList = await listApprovals(next.project.currentRunId);
          if (!active) return;
          setApprovals(approvalsList);
        }
        setError('');
        // Keep polling through awaiting_approval too: that's exactly when a
        // human decision (possibly from another tab) needs to show up live.
        if (
          next.project.status === 'queued' ||
          next.project.status === 'running' ||
          next.project.status === 'awaiting_approval'
        ) {
          timer = setTimeout(poll, 1_500);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, refreshTick]);

  const projectTerminal = detail ? PROJECT_TERMINAL_STATUSES.has(detail.project.status) : false;

  useEffect(() => {
    if (projectTerminal) return;
    const source = new EventSource(eventStreamUrl(id));
    source.onopen = () => setLive(true);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ProjectEvent;
        setEvents((current) => mergeEvents(current, [event]));
      } catch {
        // Malformed frame; drop it silently and let polling recover.
      }
    };
    source.onerror = () => setLive(false);
    return () => {
      source.close();
      setLive(false);
    };
  }, [id, projectTerminal]);

  const workflowId = detail?.project.workflowId;
  useEffect(() => {
    if (!workflowId) return;
    let active = true;
    void listWorkflows()
      .then((workflows) => {
        if (!active) return;
        setWorkflowDef(workflows.find((workflow) => workflow.id === workflowId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [workflowId]);

  useEffect(() => {
    let active = true;
    void getRuntime()
      .then((runtime) => {
        if (active) setRuntimeModels(runtime.models);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const runId = latestOperationRunId;
    if (!runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getRunDetail(runId);
        if (!active) return;
        setActiveOperationRun(next);
        if (!isWorkflowRunStatusTerminal(next.run.status)) {
          timer = setTimeout(poll, 1_500);
        } else {
          const refreshed = await getProject(id);
          if (!active) return;
          setDetail(refreshed);
          setEvents((current) => mergeEvents(current, refreshed.events));
        }
      } catch {
        // best-effort; the live-activity panel just won't update this tick
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, latestOperationRunId]);

  const refresh = () => setRefreshTick((tick) => tick + 1);

  return {
    detail,
    setDetail,
    runDetail,
    approvals,
    workflowDef,
    runtimeModels,
    events,
    live,
    activeOperationRun,
    error,
    setError,
    refresh,
  };
}
