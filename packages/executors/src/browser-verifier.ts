import {
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  type BrowserTestPlan,
  type BrowserVerificationReport,
} from '@agent-foundry/contracts';
import { RunCancelledError, type BrowserVerifier } from '@agent-foundry/domain';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from 'playwright';

const ACTION_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_OBSERVATIONS = 100;
const PASSIVE_EVENT_SETTLE_MS = 100;

type Observation = BrowserVerificationReport['steps'][number]['observations'][number];
type StepReport = BrowserVerificationReport['steps'][number];
type BrowserLocator = Exclude<
  BrowserTestPlan['steps'][number]['action'],
  { kind: 'goto' }
>['locator'];

export class PlaywrightBrowserVerifier implements BrowserVerifier {
  async verify(
    input: Parameters<BrowserVerifier['verify']>[0],
    signal: AbortSignal,
  ): Promise<BrowserVerificationReport> {
    const previewToken = input.session.url
      ? new URL(input.session.url).searchParams.get('token')
      : null;
    const previewSession = {
      ...input.session,
      ...(input.session.url ? { url: sanitizeUrl(input.session.url, previewToken) } : {}),
    };
    const parsed = BrowserTestPlanArtifactSchema.safeParse(input.planContent);
    if (!parsed.success) {
      return BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        summary: 'Browser test plan validation failed.',
        planArtifact: input.planArtifact,
        previewSession,
        planValidationError: redact(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`)
            .join('; '),
          previewToken,
        ),
        steps: [],
      });
    }
    if (!input.session.url) {
      return BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        summary: 'Browser test plan validation failed.',
        planArtifact: input.planArtifact,
        previewSession,
        planValidationError: 'Preview session URL is required.',
        steps: [],
      });
    }
    if (signal.aborted) throw new RunCancelledError();

    const previewUrl = new URL(input.session.url);
    const token = previewToken;
    const prefixPath = `/preview/${encodeURIComponent(input.session.sessionId)}/`;
    if (
      !['http:', 'https:'].includes(previewUrl.protocol) ||
      !previewUrl.pathname.startsWith(prefixPath)
    ) {
      return BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        summary: 'Browser test plan validation failed.',
        planArtifact: input.planArtifact,
        previewSession,
        planValidationError: 'Preview session URL does not match the required preview prefix.',
        steps: [],
      });
    }
    const prefixUrl = new URL(prefixPath, previewUrl.origin);
    let allowedOrigins: Set<string>;
    try {
      allowedOrigins = new Set(
        input.allowedOrigins.map((entry) => {
          const origin = new URL(entry);
          if (!['http:', 'https:'].includes(origin.protocol) || entry !== origin.origin) {
            throw new Error('Allowed origin entries must be exact HTTP(S) origins.');
          }
          return origin.origin;
        }),
      );
    } catch {
      return BrowserVerificationReportSchema.parse({
        schemaVersion: '1',
        approved: false,
        summary: 'Browser test plan validation failed.',
        planArtifact: input.planArtifact,
        previewSession,
        planValidationError: 'Allowed origin entries must be exact HTTP(S) origins.',
        steps: [],
      });
    }
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    const launch = chromium.launch({ headless: true });
    const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([signal, timeout]);

    try {
      const run = (async () => {
        browser = await launch;
        context = await browser.newContext({
          viewport: parsed.data.data.viewport,
          serviceWorkers: 'block',
        });
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
      return await Promise.race([
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
    } finally {
      if (context) await context.close().catch(() => undefined);
      const launched = browser ?? (await launch.catch(() => undefined));
      await launched?.close().catch(() => undefined);
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
  ): Promise<BrowserVerificationReport> {
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
    let currentStepIndex = 0;
    let observationCount = 0;
    let passiveFailure = false;
    const runObservations: Array<{ stepIndex: number; observation: Observation }> = [];
    const requestSteps = new WeakMap<Request, number>();
    const observe = (
      observation: Omit<Observation, 'timestamp'>,
      stepIndex = currentStepIndex,
    ): void => {
      passiveFailure = true;
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
      return (
        (previewOrigin && url.pathname.startsWith(prefixUrl.pathname)) ||
        allowedOrigins.has(url.origin)
      );
    };

    page.on('request', (request) => requestSteps.set(request, currentStepIndex));
    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', (event: { requestId: string; request: { url: string } }) => {
      const url = event.request.url;
      if (permitted(url)) {
        void cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
        return;
      }
      observe({
        kind: 'policy-block',
        message: `Blocked request to ${sanitizeUrl(url, token)}`,
        url,
      });
      void cdp
        .send('Fetch.failRequest', {
          requestId: event.requestId,
          errorReason: 'BlockedByClient',
        })
        .catch(() => {});
    });
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    await context.routeWebSocket('**/*', async (webSocket) => {
      const url = webSocket.url();
      if (permitted(url)) webSocket.connectToServer();
      else {
        observe({
          kind: 'policy-block',
          message: `Blocked WebSocket to ${sanitizeUrl(url, token)}`,
          url,
        });
        await webSocket.close({ code: 1008, reason: 'Blocked by browser verification policy' });
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        observe(
          {
            kind: 'http-error',
            message: `HTTP ${response.status()} ${sanitizeUrl(response.url(), token)}`,
            url: response.url(),
          },
          requestSteps.get(response.request()),
        );
      }
    });
    page.on('requestfailed', (request) => {
      observe(
        {
          kind: 'request-failed',
          message: `${request.failure()?.errorText ?? 'Request failed'}: ${sanitizeUrl(request.url(), token)}`,
          url: request.url(),
        },
        requestSteps.get(request),
      );
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      observe({
        kind: 'console-error',
        message: message.text(),
        ...(location ? { url: location } : {}),
      });
    });
    page.on('pageerror', (error) => {
      observe({ kind: 'uncaught-exception', message: error.message });
    });

    const steps: StepReport[] = [];
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
      currentStepIndex = index;
      const startedAt = performance.now();
      try {
        await this.executeAction(page, step.action, prefixUrl, token, index === 0);
        for (const assertion of step.assertions) {
          await this.executeAssertion(page, assertion, prefixUrl, token);
        }
        steps.push({
          stepId: step.id,
          title: step.title,
          status: 'passed',
          durationMs: performance.now() - startedAt,
          finalUrl: sanitizeUrl(page.url(), token),
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
      await page.waitForTimeout(PASSIVE_EVENT_SETTLE_MS);
    }
    for (const { stepIndex, observation } of runObservations) {
      steps[stepIndex]?.observations.push(observation);
    }
    const approved = !failed && !passiveFailure;
    return BrowserVerificationReportSchema.parse({
      schemaVersion: '1',
      approved,
      summary: approved
        ? 'All browser verification steps passed.'
        : `${failed ? 1 : 0} browser step failure(s) and ${runObservations.length} passive failure(s).`,
      planArtifact: input.planArtifact,
      previewSession,
      steps,
    });
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
        await page.goto(url.href);
        return;
      }
      case 'click':
        await locator(page, action.locator).click();
        return;
      case 'fill':
        await locator(page, action.locator).fill(action.value);
    }
  }

  private async executeAssertion(
    page: Page,
    assertion: BrowserTestPlan['steps'][number]['assertions'][number],
    prefixUrl: URL,
    token: string | null,
  ): Promise<void> {
    switch (assertion.kind) {
      case 'visible':
        await locator(page, assertion.locator).waitFor({ state: 'visible' });
        return;
      case 'hidden':
        await locator(page, assertion.locator).waitFor({ state: 'hidden' });
        return;
      case 'containsText': {
        await locator(page, assertion.locator)
          .filter({ hasText: assertion.text })
          .waitFor({ state: 'attached' });
        return;
      }
      case 'url': {
        const expected = appPath(resolvePlanPath(prefixUrl, assertion.path), prefixUrl, token);
        await page.waitForURL((url) => appPath(url, prefixUrl, token) === expected);
      }
    }
  }
}

function locator(page: Page, target: BrowserLocator): Locator {
  switch (target.kind) {
    case 'role':
      return page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
        ...(target.name ? { name: target.name } : {}),
      });
    case 'label':
      return page.getByLabel(target.text);
    case 'text':
      return page.getByText(target.text);
    case 'testId':
      return page.getByTestId(target.testId);
  }
}

function resolvePlanPath(prefixUrl: URL, path: string): URL {
  const url = new URL(path.slice(1), prefixUrl);
  url.searchParams.delete('token');
  return url;
}

function appPath(url: URL, prefixUrl: URL, token: string | null): string {
  const clean = new URL(sanitizeUrl(url.href, token));
  const pathname = clean.pathname.startsWith(prefixUrl.pathname)
    ? `/${clean.pathname.slice(prefixUrl.pathname.length)}`
    : clean.pathname;
  return `${pathname}${clean.search}${clean.hash}`;
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
