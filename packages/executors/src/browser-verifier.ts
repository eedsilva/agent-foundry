import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  MAX_NETWORK_POLICY_EVENTS,
  isSafeBrowserPath,
  type BrowserEvidencePolicy,
  type BrowserLocator,
  type BrowserTestPlan,
  type BrowserVerificationReport,
  type NetworkPolicyEvent,
} from '@agent-foundry/contracts';
import {
  RunCancelledError,
  type BrowserVerificationEvidence,
  type BrowserVerifier,
  type CapturedScreenshot,
  type SelectionScreenshotCapturer,
} from '@agent-foundry/domain';
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
  type Video,
} from 'playwright';
import { createNetworkPolicyProxy } from './network-policy-proxy.js';

const ACTION_TIMEOUT_MS = 10_000;
const SCREENSHOT_TIMEOUT_MS = 2_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_OBSERVATIONS = 100;
const MAX_TRACKED_TIMER_DELAY_MS = 1_000;
const TIMER_TRACKER_KEY = '__agentFoundryBrowserVerifierTimers';

interface TimerTrackerState {
  pending: number;
}

function installTimerTracker(input: { key: string; maxDelayMs: number }): void {
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  if (scope[input.key]) return;
  const state: TimerTrackerState = { pending: 0 };
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
  const tracked = new Set<number>();
  const companionTimers = new Map<number, number>();
  scope[input.key] = state;
  globalThis.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
    const timeout = +(delay as number);
    const effectiveTimeout = Number.isFinite(timeout) ? Math.max(0, timeout) : 0;
    if (effectiveTimeout > input.maxDelayMs) {
      return nativeSetTimeout(handler, timeout, ...args);
    }
    let timerId = 0;
    state.pending += 1;
    const finish = () => {
      if (!tracked.delete(timerId)) return;
      companionTimers.delete(timerId);
      state.pending -= 1;
    };
    if (typeof handler === 'function') {
      timerId = nativeSetTimeout(
        (...callbackArgs: unknown[]) => {
          try {
            Reflect.apply(handler, globalThis, callbackArgs);
          } finally {
            nativeSetTimeout(finish, 0);
          }
        },
        timeout,
        ...args,
      ) as unknown as number;
    } else {
      timerId = nativeSetTimeout(handler, timeout, ...args) as unknown as number;
      const companion = nativeSetTimeout(
        () => nativeSetTimeout(finish, 0),
        timeout,
      ) as unknown as number;
      companionTimers.set(timerId, companion);
    }
    tracked.add(timerId);
    return timerId;
  }) as typeof globalThis.setTimeout;
  const settleTimer = (timerId: unknown): number => {
    const normalized = +(timerId as number);
    if (Number.isFinite(normalized) && tracked.delete(normalized)) {
      const companion = companionTimers.get(normalized);
      if (companion !== undefined) nativeClearTimeout(companion);
      companionTimers.delete(normalized);
      state.pending -= 1;
    }
    return normalized;
  };
  globalThis.clearTimeout = ((timerId: number | undefined) => {
    nativeClearTimeout(settleTimer(timerId));
  }) as typeof globalThis.clearTimeout;
  globalThis.clearInterval = ((timerId: number | undefined) => {
    nativeClearInterval(settleTimer(timerId));
  }) as typeof globalThis.clearInterval;
}

type Observation = BrowserVerificationReport['steps'][number]['observations'][number];
type StepReport = BrowserVerificationReport['steps'][number];

export interface PlaywrightBrowserVerifierOptions {
  createProxy?: typeof createNetworkPolicyProxy;
  createTempDir?: typeof mkdtemp;
}

export class PlaywrightBrowserVerifier implements BrowserVerifier, SelectionScreenshotCapturer {
  private readonly createProxy: typeof createNetworkPolicyProxy;
  private readonly createTempDir: typeof mkdtemp;

  constructor(options: PlaywrightBrowserVerifierOptions = {}) {
    this.createProxy = options.createProxy ?? createNetworkPolicyProxy;
    this.createTempDir = options.createTempDir ?? mkdtemp;
  }

  async verify(
    input: Parameters<BrowserVerifier['verify']>[0],
    signal: AbortSignal,
  ): Promise<{ report: BrowserVerificationReport; evidence: BrowserVerificationEvidence }> {
    const previewToken = input.session.url
      ? new URL(input.session.url).searchParams.get('token')
      : null;
    const previewSession = {
      ...input.session,
      ...(input.session.url ? { url: sanitizeUrl(input.session.url, previewToken) } : {}),
    };
    const planValidationFailure = (
      planValidationError: string,
    ): { report: BrowserVerificationReport; evidence: BrowserVerificationEvidence } => ({
      report: BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        summary: 'Browser test plan validation failed.',
        planArtifact: input.planArtifact,
        previewSession,
        planValidationError,
        steps: [],
      }),
      evidence: { screenshots: [] },
    });
    const parsed = BrowserTestPlanArtifactSchema.safeParse(input.planContent);
    if (!parsed.success) {
      return planValidationFailure(
        redact(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
            .join('; '),
          previewToken,
        ),
      );
    }
    if (!input.session.url) {
      return planValidationFailure('Preview session URL is required.');
    }
    if (signal.aborted) throw new RunCancelledError();

    const previewUrl = new URL(input.session.url);
    const token = previewToken;
    const prefixPath = `/preview/${encodeURIComponent(input.session.sessionId)}/`;
    if (
      !['http:', 'https:'].includes(previewUrl.protocol) ||
      !previewUrl.pathname.startsWith(prefixPath)
    ) {
      return planValidationFailure(
        'Preview session URL does not match the required preview prefix.',
      );
    }
    const prefixUrl = new URL(prefixPath, previewUrl.origin);
    let allowedOriginUrls: URL[];
    try {
      allowedOriginUrls = input.allowedOrigins.map((entry) => {
        const origin = new URL(entry);
        if (!['http:', 'https:'].includes(origin.protocol) || entry !== origin.origin) {
          throw new Error('Allowed origin entries must be exact HTTP(S) origins.');
        }
        return origin;
      });
    } catch {
      return planValidationFailure('Allowed origin entries must be exact HTTP(S) origins.');
    }
    const allowedOrigins = new Set(allowedOriginUrls.map((origin) => origin.origin));
    const networkEvents: NetworkPolicyEvent[] = [];
    const previewAuthority = networkAuthority(previewUrl);
    const allowedHosts = [
      ...new Set(allowedOriginUrls.map((origin) => origin.hostname.toLowerCase())),
    ];
    const evidencePolicy: BrowserEvidencePolicy = input.evidencePolicy;
    const videoDir = evidencePolicy.captureVideo
      ? await this.createTempDir(join(tmpdir(), 'agent-foundry-browser-video-'))
      : undefined;
    const proxy = await this.createProxy({
      policy:
        allowedHosts.length > 0
          ? { mode: 'allowlist', purpose: 'browser', allowedHosts }
          : { mode: 'none', purpose: 'browser', allowedHosts: [] },
      privateExceptions: new Set([previewAuthority]),
      allowedAuthorities: new Set(allowedOriginUrls.map(networkAuthority)),
      onEvent: (event) => {
        if (networkEvents.length < MAX_NETWORK_POLICY_EVENTS) networkEvents.push(event);
      },
    }).catch(async (error: unknown) => {
      if (videoDir) await rm(videoDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    });
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let tracingStarted = false;
    const launch = chromium.launch({
      headless: true,
      proxy: { server: proxy.url, bypass: '<-loopback>' },
    });
    const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeout]);

    try {
      const run = (async () => {
        browser = await launch;
        context = await browser.newContext({
          viewport: parsed.data.data.viewport,
          serviceWorkers: 'block',
          ...(videoDir ? { recordVideo: { dir: videoDir, size: parsed.data.data.viewport } } : {}),
        });
        await context.grantPermissions(['local-network-access'], { origin: prefixUrl.origin });
        if (evidencePolicy.captureTrace) {
          await context.tracing.start({ screenshots: true, snapshots: true });
          tracingStarted = true;
        }
        return this.execute(
          context,
          parsed.data.data,
          prefixUrl,
          token,
          allowedOrigins,
          input,
          previewSession,
        );
      })();
      const result = await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          combinedSignal.addEventListener(
            'abort',
            () =>
              reject(
                signal.aborted
                  ? new RunCancelledError()
                  : new Error('Browser verification timed out.'),
              ),
            { once: true },
          );
        }),
      ]);

      let trace: Buffer | undefined;
      if (tracingStarted && context) {
        const traceDir = await this.createTempDir(join(tmpdir(), 'agent-foundry-browser-trace-'));
        const tracePath = join(traceDir, 'trace.zip');
        try {
          await context.tracing.stop({ path: tracePath });
          trace = await readFile(tracePath);
        } catch {
          // Best-effort evidence: a trace read-back failure must not fail verification.
        } finally {
          await rm(traceDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      if (context) await context.close().catch(() => undefined);
      context = undefined;

      let video: Buffer | undefined;
      if (result.video) {
        try {
          const videoPath = await result.video.path();
          video = await readFile(videoPath);
        } catch {
          // Best-effort evidence: a video read-back failure must not fail verification.
        }
      }

      return {
        report: result.report,
        evidence: {
          ...result.evidence,
          networkEvents,
          ...(trace ? { trace } : {}),
          ...(video ? { video } : {}),
        },
      };
    } finally {
      if (context) await context.close().catch(() => undefined);
      const launched = browser ?? (await launch.catch(() => undefined));
      await launched?.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      if (videoDir) await rm(videoDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async execute(
    context: BrowserContext,
    plan: BrowserTestPlan,
    prefixUrl: URL,
    token: string | null,
    allowedOrigins: Set<string>,
    input: Parameters<BrowserVerifier['verify']>[0],
    previewSession: Parameters<BrowserVerifier['verify']>[0]['session'],
  ): Promise<{
    report: BrowserVerificationReport;
    evidence: BrowserVerificationEvidence;
    video: Video | null;
  }> {
    await context.addInitScript(installTimerTracker, {
      key: TIMER_TRACKER_KEY,
      maxDelayMs: MAX_TRACKED_TIMER_DELAY_MS,
    });
    const page = await context.newPage();
    const video = page.video();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
    let activeStepIndex = 0;
    let observationCount = 0;
    let passiveFailure = false;
    const passiveFailureSteps = new Set<number>();
    const runObservations: Array<{ stepIndex: number; observation: Observation }> = [];
    const requestSteps = new WeakMap<Request, number>();
    const pendingRequests = new Set<Request>();
    const ignoredRequests = new WeakSet<Request>();
    const pendingPages = new Set<Page>();
    const workSettlers = new Set<() => void>();
    const observe = (observation: Omit<Observation, 'timestamp'>, stepIndex: number): void => {
      passiveFailure = true;
      passiveFailureSteps.add(stepIndex);
      if (observationCount >= MAX_OBSERVATIONS) return;
      runObservations.push({
        stepIndex,
        observation: {
          ...observation,
          message: redact(observation.message, token),
          ...(observation.url ? { url: sanitizeUrl(observation.url, token) } : {}),
          timestamp: new Date().toISOString(),
        },
      });
      observationCount += 1;
    };
    const permitted = (rawUrl: string): boolean => {
      const url = new URL(rawUrl);
      const prefixProtocol = prefixUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const previewOrigin =
        url.origin === prefixUrl.origin ||
        (url.protocol === prefixProtocol && url.host === prefixUrl.host);
      if (previewOrigin) {
        if (!url.pathname.startsWith(prefixUrl.pathname)) return false;
        return isSafeBrowserPath(`/${url.pathname.slice(prefixUrl.pathname.length)}`);
      }
      return allowedOrigins.has(comparisonOrigin(url));
    };
    const settleRequest = (request: Request): void => {
      pendingRequests.delete(request);
      settleWork();
    };
    const settlePage = (popup: Page): void => {
      pendingPages.delete(popup);
      settleWork();
    };
    const hasPendingWork = (): boolean =>
      pendingPages.size !== 0 ||
      [...pendingRequests].some((request) => !ignoredRequests.has(request));
    const settleWork = (): void => {
      if (hasPendingWork()) return;
      for (const settle of workSettlers) settle();
      workSettlers.clear();
    };
    const waitForPendingRequests = async (): Promise<void> => {
      if (!hasPendingWork()) return;
      const timeout = AbortSignal.timeout(ACTION_TIMEOUT_MS);
      await new Promise<void>((resolve) => {
        const settle = () => {
          timeout.removeEventListener('abort', onTimeout);
          resolve();
        };
        const onTimeout = () => {
          workSettlers.delete(settle);
          for (const request of pendingRequests) ignoredRequests.add(request);
          resolve();
        };
        workSettlers.add(settle);
        timeout.addEventListener('abort', onTimeout, { once: true });
        settleWork();
      });
    };
    const retryDuringNavigation = async <T>(
      target: Page,
      deadline: number,
      operation: () => Promise<T>,
      closedValue: T,
    ): Promise<T> => {
      for (;;) {
        try {
          return await operation();
        } catch (error) {
          if (target.isClosed()) return closedValue;
          if (!isTransientExecutionContextError(error) || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    const timerCount = (
      target: Page,
      deadline = Date.now() + ACTION_TIMEOUT_MS,
    ): Promise<number> => {
      return retryDuringNavigation(
        target,
        deadline,
        () =>
          target.evaluate(
            (key) =>
              (globalThis as typeof globalThis & Record<string, TimerTrackerState | undefined>)[key]
                ?.pending ?? 0,
            TIMER_TRACKER_KEY,
          ),
        0,
      );
    };
    const waitForTrackedTimers = async (deadline: number): Promise<boolean> => {
      for (;;) {
        if (Date.now() >= deadline) return false;
        for (const target of context.pages()) {
          if (target.isClosed()) continue;
          try {
            await retryDuringNavigation(
              target,
              deadline,
              () =>
                target.waitForFunction(
                  (key) =>
                    ((
                      globalThis as typeof globalThis &
                        Record<string, TimerTrackerState | undefined>
                    )[key]?.pending ?? 0) === 0,
                  TIMER_TRACKER_KEY,
                  { polling: 'raf', timeout: Math.max(1, deadline - Date.now()) },
                ),
              undefined,
            );
          } catch (error) {
            if (error instanceof errors.TimeoutError && Date.now() >= deadline) return false;
            throw error;
          }
        }
        if (Date.now() >= deadline) return false;
        const openPages = context.pages().filter((target) => !target.isClosed());
        await Promise.all(
          openPages.map((target) =>
            retryDuringNavigation(
              target,
              deadline,
              () => target.evaluate(() => Promise.resolve()),
              undefined,
            ),
          ),
        );
        if (Date.now() >= deadline) return false;
        if (
          (await Promise.all(openPages.map((target) => timerCount(target, deadline)))).every(
            (count) => count === 0,
          )
        )
          return true;
      }
    };
    const waitForQuiescence = async (): Promise<void> => {
      const deadline = Date.now() + ACTION_TIMEOUT_MS;
      for (;;) {
        await waitForPendingRequests();
        if (Date.now() >= deadline) return;
        if (!(await waitForTrackedTimers(deadline))) return;
        if (Date.now() >= deadline) return;
        const timerCounts = await Promise.all(
          context.pages().map((target) => timerCount(target, deadline)),
        );
        if (!hasPendingWork() && timerCounts.every((count) => count === 0)) return;
        if (Date.now() >= deadline) return;
      }
    };
    const observePage = (target: Page): void => {
      const onConsole = (message: ConsoleMessage): void => {
        if (message.type() !== 'error') return;
        const location = message.location().url;
        observe(
          {
            kind: 'console-error',
            message: message.text(),
            ...(location ? { url: location } : {}),
          },
          activeStepIndex,
        );
      };
      const onPageError = (error: Error): void => {
        observe({ kind: 'uncaught-exception', message: error.message }, activeStepIndex);
      };
      target.on('console', onConsole);
      target.on('pageerror', onPageError);
    };

    observePage(page);
    context.on('request', (request) => {
      requestSteps.set(request, activeStepIndex);
      pendingRequests.add(request);
    });
    context.on('requestfinished', settleRequest);
    context.on('requestfailed', (request) => {
      observe(
        {
          kind: 'request-failed',
          message: `${request.failure()?.errorText ?? 'Request failed'}: ${sanitizeUrl(request.url(), token)}`,
          url: request.url(),
        },
        requestSteps.get(request) ?? activeStepIndex,
      );
      settleRequest(request);
    });
    context.on('page', (popup) => {
      observePage(popup);
      pendingPages.add(popup);
      void popup
        .waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS })
        .catch(() => undefined)
        .finally(() => settlePage(popup));
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const stepIndex = requestSteps.get(request) ?? activeStepIndex;
      try {
        if (!permitted(url)) {
          observe(
            {
              kind: 'policy-block',
              message: `Blocked request to ${sanitizeUrl(url, token)}`,
              url,
            },
            stepIndex,
          );
          await route.abort('blockedbyclient');
          return;
        }
        const response = await route.fetch({ maxRedirects: 0, timeout: 0 });
        const location = [301, 302, 303, 307, 308].includes(response.status())
          ? response.headers().location
          : undefined;
        const redirect = location ? new URL(location, url).href : undefined;
        if (redirect && !permitted(redirect)) {
          observe(
            {
              kind: 'policy-block',
              message: `Blocked request to ${sanitizeUrl(redirect, token)}`,
              url: redirect,
            },
            stepIndex,
          );
          await route.abort('blockedbyclient');
          return;
        }
        await route.fulfill({ response });
      } catch {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    await context.routeWebSocket('**/*', async (webSocket) => {
      const url = webSocket.url();
      const stepIndex = activeStepIndex;
      if (permitted(url)) webSocket.connectToServer();
      else {
        observe(
          {
            kind: 'policy-block',
            message: `Blocked WebSocket to ${sanitizeUrl(url, token)}`,
            url,
          },
          stepIndex,
        );
        await webSocket.close({ code: 1008, reason: 'Blocked by browser verification policy' });
      }
    });
    context.on('response', (response) => {
      if (response.status() >= 400) {
        observe(
          {
            kind: 'http-error',
            message: `HTTP ${response.status()} ${sanitizeUrl(response.url(), token)}`,
            url: response.url(),
          },
          requestSteps.get(response.request()) ?? activeStepIndex,
        );
      }
    });
    const steps: StepReport[] = [];
    const screenshots: CapturedScreenshot[] = [];
    let failed = false;
    for (const [index, step] of plan.steps.entries()) {
      if (failed) {
        steps.push({
          stepId: step.id,
          title: step.title,
          status: 'skipped',
          durationMs: 0,
          observations: [],
        });
        continue;
      }
      activeStepIndex = index;
      const startedAt = performance.now();
      try {
        await this.executeAction(page, step.action, prefixUrl, token, index === 0);
        for (const assertion of step.assertions) {
          await this.executeAssertion(page, assertion, prefixUrl);
        }
        await waitForQuiescence();
        if (passiveFailureSteps.has(index)) {
          failed = true;
        }
        steps.push({
          stepId: step.id,
          title: step.title,
          status: failed ? 'failed' : 'passed',
          durationMs: performance.now() - startedAt,
          finalUrl: sanitizeUrl(page.url(), token),
          ...(failed ? { error: 'Passive browser failure observed.' } : {}),
          observations: [],
        });
      } catch (error) {
        failed = true;
        steps.push({
          stepId: step.id,
          title: step.title,
          status: 'failed',
          durationMs: performance.now() - startedAt,
          ...(page.url() !== 'about:blank' ? { finalUrl: sanitizeUrl(page.url(), token) } : {}),
          error: redact(errorMessage(error), token),
          observations: [],
        });
      }
      await this.captureScreenshot(page, step.id, plan.viewport, token, screenshots);
    }
    for (const { stepIndex, observation } of runObservations) {
      steps[stepIndex]?.observations.push(observation);
    }
    for (const stepIndex of passiveFailureSteps) {
      const step = steps[stepIndex];
      if (step?.status === 'passed') {
        step.status = 'failed';
        step.error = 'Passive browser failure observed.';
      }
    }
    const approved = !failed && !passiveFailure;
    return {
      report: BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved,
        summary: approved
          ? 'All browser verification steps passed.'
          : `${steps.filter((step) => step.status === 'failed').length} browser step failure(s) and ${runObservations.length} passive failure(s).`,
        planArtifact: input.planArtifact,
        previewSession,
        steps,
      }),
      evidence: { screenshots },
      video,
    };
  }

  /** On-demand, single-shot screenshot against a live preview session — not
   * the scheduled verify() flow. Launches its own short-lived browser/context,
   * navigates once, and screenshots the given viewport-relative clip.
   * ponytail: no route()/permitted() policy enforcement here — this only ever
   * navigates to the caller-supplied, already-authorized preview session URL
   * (validated by the caller against its own session record before this is
   * invoked). Revisit if ever exposed to a caller-supplied arbitrary URL. */
  async captureSelectionScreenshot(input: {
    url: string;
    clip: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  }): Promise<Buffer | null> {
    let browser: Browser | undefined;
    let proxy: Awaited<ReturnType<typeof createNetworkPolicyProxy>> | undefined;
    try {
      const url = new URL(input.url);
      proxy = await this.createProxy({
        policy: { mode: 'none', purpose: 'browser', allowedHosts: [] },
        privateExceptions: new Set([networkAuthority(url)]),
        onEvent: () => undefined,
      });
      browser = await chromium.launch({
        headless: true,
        proxy: { server: proxy.url, bypass: '<-loopback>' },
      });
      const context = await browser.newContext({ viewport: input.viewport });
      const page = await context.newPage();
      await page.goto(input.url, { timeout: ACTION_TIMEOUT_MS });
      return await page.screenshot({
        type: 'png',
        clip: input.clip,
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
    } catch {
      return null; // best-effort: the UI degrades to "no screenshot" rather than failing selection
    } finally {
      await browser?.close().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
    }
  }

  private async captureScreenshot(
    page: Page,
    stepId: string,
    viewport: { width: number; height: number },
    token: string | null,
    sink: CapturedScreenshot[],
  ): Promise<void> {
    try {
      const buffer = await page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
      sink.push({ stepId, url: sanitizeUrl(page.url(), token), viewport, buffer });
    } catch {
      // Best-effort evidence: a closed or mid-navigation page must not fail verification.
    }
  }

  private async executeAction(
    page: Page,
    action: BrowserTestPlan['steps'][number]['action'],
    prefixUrl: URL,
    token: string | null,
    initialNavigation: boolean,
  ): Promise<void> {
    switch (action.kind) {
      case 'goto': {
        const url = resolvePlanPath(prefixUrl, action.path);
        if (initialNavigation && token) url.searchParams.set('token', token);
        await page.goto(url.href, { timeout: ACTION_TIMEOUT_MS });
        return;
      }
      case 'click':
        await locator(page, action.locator).click({ timeout: ACTION_TIMEOUT_MS });
        return;
      case 'fill':
        await locator(page, action.locator).fill(action.value, { timeout: ACTION_TIMEOUT_MS });
    }
  }

  private async executeAssertion(
    page: Page,
    assertion: BrowserTestPlan['steps'][number]['assertions'][number],
    prefixUrl: URL,
  ): Promise<void> {
    switch (assertion.kind) {
      case 'visible':
        await locator(page, assertion.locator).waitFor({
          state: 'visible',
          timeout: ACTION_TIMEOUT_MS,
        });
        return;
      case 'hidden':
        await locator(page, assertion.locator).waitFor({
          state: 'hidden',
          timeout: ACTION_TIMEOUT_MS,
        });
        return;
      case 'containsText': {
        await locator(page, assertion.locator)
          .filter({ hasText: assertion.expected })
          .waitFor({ state: 'attached', timeout: ACTION_TIMEOUT_MS });
        return;
      }
      case 'url': {
        const expected = resolvePlanPath(prefixUrl, assertion.path);
        await page.waitForURL(
          (url) => {
            const actual = new URL(url);
            actual.searchParams.delete('token');
            return actual.href === expected.href;
          },
          { timeout: ACTION_TIMEOUT_MS },
        );
      }
    }
  }
}

function locator(page: Page, target: BrowserLocator): Locator {
  switch (target.by) {
    case 'role':
      return page.getByRole(target.role, {
        ...(target.name ? { name: target.name } : {}),
        ...(target.exact === undefined ? {} : { exact: target.exact }),
      });
    case 'label':
      return page.getByLabel(
        target.label,
        target.exact === undefined ? {} : { exact: target.exact },
      );
    case 'text':
      return page.getByText(target.text, target.exact === undefined ? {} : { exact: target.exact });
    case 'testId':
      return page.getByTestId(target.testId);
  }
}

function resolvePlanPath(prefixUrl: URL, path: string): URL {
  if (!isSafeBrowserPath(path)) {
    throw new Error('Browser path escapes the preview session prefix.');
  }
  const url = new URL(path.slice(1), prefixUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== prefixUrl.origin ||
    !url.pathname.startsWith(prefixUrl.pathname)
  ) {
    throw new Error('Browser path escapes the preview session prefix.');
  }
  url.searchParams.delete('token');
  return url;
}

function sanitizeUrl(rawUrl: string, token: string | null): string {
  const url = new URL(rawUrl);
  url.searchParams.delete('token');
  return redact(url.href, token);
}

function redact(value: string, token: string | null): string {
  if (!token) return value;
  return value.split(token).join('[REDACTED]').split(encodeURIComponent(token)).join('[REDACTED]');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientExecutionContextError(error: unknown): boolean {
  return /execution context was destroyed|cannot find context with specified id|frame was detached/i.test(
    errorMessage(error),
  );
}

function comparisonOrigin(url: URL): string {
  if (url.protocol === 'ws:') return `http://${url.host}`;
  if (url.protocol === 'wss:') return `https://${url.host}`;
  return url.origin;
}

function networkAuthority(url: URL): string {
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  return `${url.hostname.toLowerCase()}:${port}`;
}
