import {
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  type BrowserTestPlan,
  type BrowserVerificationReport,
} from '@agent-foundry/contracts';
import { RunCancelledError, type BrowserVerifier } from '@agent-foundry/domain';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

const ACTION_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_OBSERVATIONS = 100;

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
    const prefixUrl = new URL(previewUrl);
    prefixUrl.search = '';
    prefixUrl.hash = '';
    if (!prefixUrl.pathname.endsWith('/')) prefixUrl.pathname += '/';
    const allowedOrigins = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
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
    let activeObservations: Observation[] | undefined;
    let observationCount = 0;
    const observe = (observation: Omit<Observation, 'timestamp'>): void => {
      if (!activeObservations || observationCount >= MAX_OBSERVATIONS) return;
      activeObservations.push({
        ...observation,
        message: redact(observation.message, token),
        ...(observation.url ? { url: sanitizeUrl(observation.url, token) } : {}),
        timestamp: new Date().toISOString(),
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

    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (permitted(url)) await route.continue();
      else {
        observe({
          kind: 'policy-block',
          message: `Blocked request to ${sanitizeUrl(url, token)}`,
          url,
        });
        await route.abort('blockedbyclient');
      }
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
        observe({
          kind: 'http-error',
          message: `HTTP ${response.status()} ${sanitizeUrl(response.url(), token)}`,
          url: response.url(),
        });
      }
    });
    page.on('requestfailed', (request) => {
      observe({
        kind: 'request-failed',
        message: `${request.failure()?.errorText ?? 'Request failed'}: ${sanitizeUrl(request.url(), token)}`,
        url: request.url(),
      });
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
      const observations: Observation[] = [];
      activeObservations = observations;
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
          observations,
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
          observations,
        });
      }
    }
    activeObservations = undefined;
    const passiveFailures = steps.reduce((count, step) => count + step.observations.length, 0);
    const approved = !failed && passiveFailures === 0;
    return BrowserVerificationReportSchema.parse({
      schemaVersion: '1',
      approved,
      summary: approved
        ? 'All browser verification steps passed.'
        : `${failed ? 1 : 0} browser step failure(s) and ${passiveFailures} passive failure(s).`,
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
        const target = locator(page, assertion.locator);
        await target.waitFor({ state: 'attached' });
        const text = await target.textContent();
        if (!text?.includes(assertion.text)) {
          throw new Error(
            `Expected locator text to contain "${assertion.text}"; received "${text ?? ''}".`,
          );
        }
        return;
      }
      case 'url': {
        const expected = appPath(resolvePlanPath(prefixUrl, assertion.path), prefixUrl, token);
        const actual = appPath(new URL(page.url()), prefixUrl, token);
        if (actual !== expected)
          throw new Error(`Expected URL path "${expected}"; received "${actual}".`);
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
