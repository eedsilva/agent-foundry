import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  bootIssueRadarApp,
  teardownIssueRadarApp,
  type IssueRadarFixture,
} from './issue-radar-fixture.js';

const SETUP_TIMEOUT_MS = 10 * 60_000;

async function signUp(page: import('@playwright/test').Page, baseUrl: string) {
  const email = `radar-${randomUUID()}@example.test`;
  const password = `Radar-${randomUUID()}-Aa1!`;
  await page.goto(`${baseUrl}/sign-up`);
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(`${baseUrl}/projects`);
}

test.describe('issue radar cross-user access', () => {
  test.describe.configure({ timeout: SETUP_TIMEOUT_MS });

  let fixture: IssueRadarFixture;

  test.beforeAll(async () => {
    fixture = await bootIssueRadarApp('issue-radar-cross-user-e2e');
  });

  test.afterAll(async () => {
    await teardownIssueRadarApp(fixture);
  });

  test("user B cannot see, open, or edit user A's project or issue", async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, fixture.appBaseUrl);
    await pageA.getByPlaceholder('Project name').fill("A's private project");
    await pageA.getByRole('button', { name: 'New project' }).click();
    await expect(pageA.getByRole('heading', { name: "A's private project" })).toBeVisible();
    const projectUrl = pageA.url();

    await pageA.getByRole('link', { name: 'New issue' }).click();
    await pageA.getByLabel('Title').fill("A's private issue");
    await pageA.getByRole('button', { name: 'Save' }).click();
    await expect(pageA.getByText("A's private issue")).toBeVisible();
    await pageA.getByRole('link', { name: /A's private issue/ }).click();
    await expect(pageA).toHaveURL(/\/issues\//);
    const issueUrl = pageA.url();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUp(pageB, fixture.appBaseUrl);

    // B's own project list must not contain A's project.
    await expect(pageB.getByText("A's private project")).not.toBeVisible();
    await expect(pageB.getByText('No projects yet. Create one above.')).toBeVisible();

    // Direct navigation to A's project/issue URLs must not leak data:
    // RLS makes the row invisible to B, so the page 404s via notFound().
    await pageB.goto(projectUrl);
    await expect(pageB.getByText(/this page could not be found/i)).toBeVisible();

    await pageB.goto(issueUrl);
    await expect(pageB.getByText(/this page could not be found/i)).toBeVisible();

    await Promise.all([contextA.close(), contextB.close()]);
  });
});
