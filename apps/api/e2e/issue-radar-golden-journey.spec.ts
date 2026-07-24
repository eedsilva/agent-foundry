import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { bootIssueRadarApp, teardownIssueRadarApp, type IssueRadarFixture } from './issue-radar-fixture.js';

const SETUP_TIMEOUT_MS = 10 * 60_000;
const FIXTURE_IMAGE = resolve(import.meta.dirname, 'fixtures/design-reference.png');

test.describe('issue radar golden journey', () => {
  test.describe.configure({ timeout: SETUP_TIMEOUT_MS });

  let fixture: IssueRadarFixture;

  test.beforeAll(async () => {
    fixture = await bootIssueRadarApp('issue-radar-golden-journey-e2e');
  });

  test.afterAll(async () => {
    await teardownIssueRadarApp(fixture);
  });

  test('signs up, creates a project, manages an issue end to end, and uploads an attachment', async ({
    page,
  }) => {
    const email = `radar-${randomUUID()}@example.test`;
    const password = `Radar-${randomUUID()}-Aa1!`;

    await page.goto(`${fixture.appBaseUrl}/sign-up`);
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(`${fixture.appBaseUrl}/projects`);

    await page.getByPlaceholder('Project name').fill('Website relaunch');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('heading', { name: 'Website relaunch' })).toBeVisible();

    await page.getByRole('link', { name: 'New issue' }).click();
    await page.getByLabel('Title').fill('Fix broken checkout button');
    await page.getByLabel('Description').fill('Checkout button does nothing on Safari.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Fix broken checkout button')).toBeVisible();
    await expect(page.getByText('open', { exact: true })).toBeVisible();

    // Dashboard reflects the new issue immediately.
    await expect(page.locator('dd', { hasText: '1' }).first()).toBeVisible();

    // Complete, then reopen.
    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByRole('button', { name: 'Complete' })).toBeVisible();

    // Filter by priority=high should hide the medium-priority issue.
    await page.goto(`${page.url().split('?')[0]}?priority=high`);
    await expect(page.getByText('No issues match the current filters.')).toBeVisible();
    await page.goto(page.url().split('?')[0]);

    // Attach a file to the issue.
    await page.getByText('Fix broken checkout button').click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_IMAGE);
    await expect(page.getByRole('link', { name: /design-reference/ })).toBeVisible({
      timeout: 15_000,
    });

    expect(readFileSync(FIXTURE_IMAGE)).toBeTruthy(); // sanity: fixture file exists and is readable
  });
});
